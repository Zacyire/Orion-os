//! LTF OS — backend entry point.
//!
//! Serves the desktop shell from `static/`, the JSON API under `/api`, the
//! web layer (`/api/web/inspect`, `/proxy/page`, `/proxy/fetch`, `/net/…`;
//! see src/web/mod.rs) and a WebSocket event bus at `/ws`.

mod catalog;
mod config;
mod error;
mod handlers;
mod state;
mod sysstats;
mod web;

use std::{net::SocketAddr, sync::Arc};

use axum::{
    extract::Request,
    http::{Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use tower_http::{compression::CompressionLayer, services::ServeDir, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

use crate::{config::Config, state::AppState};

type BoxError = Box<dyn std::error::Error + Send + Sync>;

#[tokio::main]
async fn main() -> Result<(), BoxError> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("ltf_os=info,tower_http=warn")))
        .init();

    let config = Config::from_env();
    let port = config.port;
    tracing::info!(
        proxy = config.proxy_enabled,
        allowlist = config.proxy_allow.len(),
        rate_limit_per_min = config.rate_limit_per_min,
        youtube_search = config.youtube_api_key.is_some(),
        "configuration loaded"
    );
    if config.proxy_allow_private {
        tracing::warn!("LTF_PROXY_ALLOW_PRIVATE is set: /proxy can reach private and loopback addresses");
    }
    let state = Arc::new(AppState::load(config).await?);

    let app = build_app(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("LTF OS listening on http://localhost:{port}");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
        })
        .await?;
    Ok(())
}

/// The full HTTP surface: JSON API, web layer, event socket and static shell.
fn build_app(state: state::SharedState) -> Router {
    let static_dir = state.config.static_dir.clone();
    use handlers::*;
    let api = Router::new()
        .route("/system/info", get(system::info))
        .route("/system/boot-log", get(system::boot_log))
        .route("/system/stats", get(system::stats))
        .route("/ping", get(system::ping))
        .route("/prefs", get(prefs::get_prefs).put(prefs::put_prefs).patch(prefs::patch_prefs))
        .route("/prefs/reset", post(prefs::reset_prefs))
        .route("/apps", get(apps::list))
        .route("/apps/custom", post(apps::add_custom))
        .route("/apps/{id}/install", post(apps::install))
        .route("/apps/{id}", axum::routing::delete(apps::uninstall))
        .route("/files", get(files::list))
        .route("/files/upload", post(files::upload))
        .route("/files/{name}", get(files::read).put(files::write).delete(files::remove))
        .route("/files/{name}/download", get(files::download))
        .route("/content/{kind}", get(content::get))
        .route("/youtube/search", get(youtube::search))
        .layer(middleware::from_fn(require_client_header));

    // Web layer (src/web): everything that contacts remote sites, rate limited per client.
    let web_routes = Router::new()
        .route("/api/web/inspect", get(web::inspect::handler))
        .route("/proxy/page", get(web::page::handler))
        .route("/proxy/fetch", get(web::fetch::by_query))
        .route("/net/{target}", get(web::fetch::by_path))
        .route_layer(middleware::from_fn_with_state(state.clone(), web::limit::middleware));

    Router::new()
        .merge(web_routes)
        .nest("/api", api)
        .route("/ws", get(ws::upgrade))
        .fallback_service(ServeDir::new(&static_dir).append_index_html_on_directories(true))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// CSRF guard: state-changing API calls must carry `X-LTF-Client`. A custom
/// header forces a CORS preflight, which cross-origin pages (including
/// sandboxed proxied pages) cannot pass because no CORS headers are sent.
async fn require_client_header(req: Request, next: Next) -> Response {
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !safe && !req.headers().contains_key("x-ltf-client") {
        return (StatusCode::FORBIDDEN, "missing X-LTF-Client header").into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    //! Route-level tests through the real router (`build_app`) and real state.

    use std::{
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use axum::{
        body::{to_bytes, Body},
        http::{header, Request, StatusCode},
    };
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;

    struct TestApp {
        router: Router,
        data_dir: PathBuf,
    }

    impl Drop for TestApp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.data_dir);
        }
    }

    async fn test_app() -> TestApp {
        static N: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let data_dir = std::env::temp_dir().join(format!("ltf-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let mut config = Config::from_env();
        config.data_dir = data_dir.clone();
        let state = Arc::new(AppState::load(config).await.expect("state"));
        TestApp { router: build_app(state), data_dir }
    }

    async fn send(app: &TestApp, method: &str, uri: &str, client_header: bool) -> (StatusCode, header::HeaderMap, Vec<u8>) {
        let mut req = Request::builder().method(method).uri(uri);
        if client_header {
            req = req.header("x-ltf-client", "1");
        }
        let res = app.router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec();
        (status, headers, body)
    }

    async fn get_json(app: &TestApp, uri: &str) -> Value {
        let (status, headers, body) = send(app, "GET", uri, false).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert!(headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("application/json"), "{uri} content-type");
        serde_json::from_slice(&body).unwrap_or_else(|e| panic!("{uri}: invalid JSON: {e}"))
    }

    /// Every key path in a JSON value, e.g. "cpu.usage_percent".
    fn key_paths(v: &Value, prefix: &str, out: &mut Vec<String>) {
        if let Value::Object(map) = v {
            for (k, child) in map {
                let p = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                out.push(p.clone());
                key_paths(child, &p, out);
            }
        }
    }

    fn sorted_paths(v: &Value) -> Vec<String> {
        let mut out = Vec::new();
        key_paths(v, "", &mut out);
        out.sort();
        out
    }

    const STATS_SCHEMA: &[&str] = &[
        "cpu", "cpu.logical_cores", "cpu.usage_percent",
        "memory", "memory.available_bytes", "memory.total_bytes", "memory.used_bytes",
        "platform", "platform.arch", "platform.os", "platform.supported",
        "sampled_at_ms", "schema", "uptime_seconds",
    ];

    async fn settled_stats(app: &TestApp) -> Value {
        tokio::time::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL + std::time::Duration::from_millis(50)).await;
        get_json(app, "/api/system/stats").await
    }

    #[tokio::test]
    async fn stats_endpoint_exists_returns_json_and_is_not_cacheable() {
        let app = test_app().await;
        let (status, headers, body) = send(&app, "GET", "/api/system/stats", false).await;
        assert_eq!(status, StatusCode::OK);
        assert!(headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("application/json"));
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        let _: Value = serde_json::from_slice(&body).expect("valid JSON");
    }

    #[tokio::test]
    async fn stats_schema_is_exactly_the_allowlist() {
        let app = test_app().await;
        let v = settled_stats(&app).await;
        assert_eq!(sorted_paths(&v), STATS_SCHEMA, "schema drifted — update docs/system-stats.md and bump schema");
        assert_eq!(v["schema"], 1);
    }

    #[tokio::test]
    async fn stats_values_are_sane() {
        let app = test_app().await;
        let v = settled_stats(&app).await;
        assert_eq!(v["platform"]["os"], std::env::consts::OS);
        assert_eq!(v["platform"]["arch"], std::env::consts::ARCH);
        assert!(v["sampled_at_ms"].as_u64().unwrap() > 1_600_000_000_000);
        if v["platform"]["supported"] != true {
            return;
        }
        let usage = v["cpu"]["usage_percent"].as_f64().expect("usage after a full interval");
        assert!((0.0..=100.0).contains(&usage), "usage {usage}");
        assert!(v["cpu"]["logical_cores"].as_u64().unwrap() >= 1);
        let total = v["memory"]["total_bytes"].as_u64().expect("total memory");
        assert!(total > 0, "total memory must be nonzero");
        assert!(v["memory"]["used_bytes"].as_u64().unwrap() <= total, "used > total");
        assert!(v["memory"]["available_bytes"].as_u64().unwrap() <= total, "available > total");
        assert!(v["uptime_seconds"].as_u64().is_some(), "uptime must be a nonnegative integer");
    }

    #[tokio::test]
    async fn stats_contain_no_sensitive_host_information() {
        let app = test_app().await;
        let v = settled_stats(&app).await;
        let text = v.to_string();
        // Only three strings exist, and none may look like a path.
        let mut strings = Vec::new();
        fn collect<'a>(v: &'a Value, out: &mut Vec<&'a str>) {
            match v {
                Value::String(s) => out.push(s),
                Value::Array(a) => a.iter().for_each(|x| collect(x, out)),
                Value::Object(m) => m.values().for_each(|x| collect(x, out)),
                _ => {}
            }
        }
        collect(&v, &mut strings);
        assert_eq!(strings.len(), 2, "only platform.os and platform.arch are strings: {strings:?}");
        assert!(!text.contains('/') && !text.contains('\\'), "no paths: {text}");
        // Nothing identifying this host or user.
        let mut secrets: Vec<String> = ["USER", "LOGNAME", "USERNAME", "HOME", "HOSTNAME", "PATH", "PWD"]
            .iter()
            .filter_map(|k| std::env::var(k).ok())
            .collect();
        secrets.extend(std::fs::read_to_string("/proc/sys/kernel/hostname").ok().map(|h| h.trim().to_string()));
        secrets.push(std::env::current_dir().unwrap().display().to_string());
        secrets.push(app.data_dir.display().to_string());
        for s in secrets.iter().filter(|s| s.len() >= 3) {
            assert!(!text.contains(s.as_str()), "response leaks {s:?}: {text}");
        }
    }

    #[tokio::test]
    async fn stats_ignores_parameters_and_rejects_other_methods() {
        let app = test_app().await;
        let plain = settled_stats(&app).await;
        // Query parameters can't select files, commands or processes.
        let (status, _, body) = send(&app, "GET", "/api/system/stats?path=/etc/passwd&cmd=id&pid=1&file=../../x", false).await;
        assert_eq!(status, StatusCode::OK);
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(sorted_paths(&v), sorted_paths(&plain));
        let text = String::from_utf8_lossy(&body);
        assert!(!text.contains("passwd") && !text.contains("root:") && !text.contains("cmd"), "{text}");
        // Read-only: no write verb reaches the handler.
        for m in ["POST", "PUT", "PATCH", "DELETE"] {
            let (s, _, _) = send(&app, m, "/api/system/stats", false).await;
            assert_eq!(s, StatusCode::FORBIDDEN, "{m} without X-LTF-Client must hit the CSRF guard");
            let (s, _, body) = send(&app, m, "/api/system/stats", true).await;
            assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED, "{m} with X-LTF-Client");
            assert!(serde_json::from_slice::<Value>(&body).map(|v| v.get("cpu").is_none()).unwrap_or(true));
        }
        // Sub-paths and traversal don't reach anything.
        for uri in ["/api/system/stats/etc/passwd", "/api/system/stats/../../../../etc/passwd", "/api/system/stats%2F..%2F..%2Fetc%2Fpasswd"] {
            let (s, _, body) = send(&app, "GET", uri, false).await;
            assert_ne!(s, StatusCode::OK, "{uri}");
            assert!(!String::from_utf8_lossy(&body).contains("root:"), "{uri}");
        }
    }

    /// The boundary that keeps third-party web apps (cross-origin direct/embed
    /// frames, opaque-origin /proxy/page documents) from reading this data is
    /// that the server grants no CORS access. Adding a permissive CORS layer
    /// would silently open it, so pin it here.
    #[tokio::test]
    async fn stats_grant_no_cross_origin_read_access() {
        let app = test_app().await;
        for origin in ["https://evil.example", "null"] {
            for method in ["GET", "OPTIONS"] {
                let req = Request::builder()
                    .method(method)
                    .uri("/api/system/stats")
                    .header(header::ORIGIN, origin)
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                    .body(Body::empty())
                    .unwrap();
                let res = app.router.clone().oneshot(req).await.unwrap();
                let leaked: Vec<_> = res.headers().keys().filter(|k| k.as_str().starts_with("access-control-allow")).collect();
                assert!(leaked.is_empty(), "{method} from {origin}: CORS headers {leaked:?}");
            }
        }
    }

    #[tokio::test]
    async fn existing_endpoints_are_unchanged() {
        let app = test_app().await;
        // /system/info keeps its exact shape (Settings and YouTube read it).
        let info = get_json(&app, "/api/system/info").await;
        assert_eq!(
            sorted_paths(&info),
            ["arch", "features", "features.proxy", "features.proxy_allowlist", "features.youtube_search", "name", "platform", "server", "uptime_secs", "version"]
        );
        assert_eq!(info["name"], "LTF OS");
        let ping = get_json(&app, "/api/ping").await;
        assert_eq!(ping["pong"], true);
        assert!(get_json(&app, "/api/system/boot-log").await.as_array().is_some_and(|a| !a.is_empty()));
        let apps = get_json(&app, "/api/apps").await;
        assert!(apps.as_array().unwrap().iter().any(|a| a["id"] == "playground"));
        // CSRF guard still applies to other state-changing routes.
        let (s, _, _) = send(&app, "POST", "/api/prefs/reset", false).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        // The static shell is still served.
        let (s, _, body) = send(&app, "GET", "/", false).await;
        assert_eq!(s, StatusCode::OK);
        assert!(String::from_utf8_lossy(&body).contains("<html"));
    }
}
