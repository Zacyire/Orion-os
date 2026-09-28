//! Orion OS — backend entry point.
//!
//! Serves the desktop shell from `static/`, the JSON API under `/api`, the
//! web layer (`/api/web/inspect`, `/proxy/page`, `/proxy/fetch`, `/net/…`;
//! see src/web/mod.rs) and a WebSocket event bus at `/ws`. With an access key
//! configured, everything except `/login`, `/logout` and `/healthz` requires a
//! signed-in session (src/auth.rs).

mod auth;
mod catalog;
mod config;
mod error;
mod handlers;
mod hosts;
mod netstats;
mod state;
mod sysstats;
mod web;

use std::{net::SocketAddr, sync::Arc};

use axum::{
    extract::{Request, State},
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
    if let Err(e) = config.validate() {
        tracing::error!("refusing to start: {e}");
        return Err(e.into());
    }
    let port = config.port;
    let bind = config.bind;
    tracing::info!(
        mode = ?config.mode,
        %bind,
        trusted_hosts = config.allowed_hosts.len(),
        access_gate = config.access_key.is_some(),
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

    let addr = SocketAddr::new(bind, port);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("Orion OS listening on http://{addr}");
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
        .route("/network/stats", get(network::stats))
        .route("/ping", get(system::ping))
        .route("/session", get(auth::session_info))
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
        .route("/login", get(auth::login_form).post(auth::login))
        .route("/logout", post(auth::logout))
        .route("/healthz", get(auth::healthz))
        .fallback_service(ServeDir::new(&static_dir).append_index_html_on_directories(true))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        // Access gate (no-op without an access key). Runs after the
        // Host check, before every route, including /ws and static files.
        .layer(middleware::from_fn_with_state(state.clone(), auth::require_access))
        // Outermost: refuse untrusted Host values before any route runs.
        .layer(middleware::from_fn_with_state(state.clone(), require_trusted_host))
        .with_state(state)
}

/// DNS-rebinding guard: every request must name a trusted host (src/hosts.rs).
/// HTTP/1.1 carries it in `Host`; HTTP/2 in the URI authority. If both are
/// present they must agree.
async fn require_trusted_host(State(state): State<state::SharedState>, req: Request, next: Next) -> Response {
    let header = req.headers().get(axum::http::header::HOST).and_then(|v| v.to_str().ok());
    let authority = req.uri().authority().map(|a| a.as_str());
    let host = match (header, authority) {
        (Some(h), Some(a)) if !h.eq_ignore_ascii_case(a) => None,
        (Some(h), _) => Some(h),
        (None, a) => a,
    };
    if !host.is_some_and(|h| state.hosts.allows_host_header(h)) {
        return (StatusCode::FORBIDDEN, "unrecognized host").into_response();
    }
    next.run(req).await
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
        test_app_with(|_| {}).await
    }

    async fn test_app_with(tweak: impl FnOnce(&mut Config)) -> TestApp {
        static N: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let data_dir = std::env::temp_dir().join(format!("ltf-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let mut config = Config::from_env();
        config.data_dir = data_dir.clone();
        // Tests must never touch the public internet: disable the connectivity
        // check by default; individual tests point it at a local mock.
        config.netcheck_url = None;
        tweak(&mut config);
        let state = Arc::new(AppState::load(config).await.expect("state"));
        TestApp { router: build_app(state), data_dir }
    }

    /// Local HTTP server answering 200 to anything; returns its base URL.
    async fn local_ok_server() -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").await;
                });
            }
        });
        format!("http://{addr}/")
    }

    async fn send(app: &TestApp, method: &str, uri: &str, client_header: bool) -> (StatusCode, header::HeaderMap, Vec<u8>) {
        let mut req = Request::builder().method(method).uri(uri).header(header::HOST, "localhost:8080");
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
                    .header(header::HOST, "localhost:8080")
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

    const NET_SCHEMA: &[&str] = &["latency_ms", "online", "sampled_at_ms", "schema"];

    #[tokio::test]
    async fn network_stats_shape_headers_and_online_measurement() {
        let target = local_ok_server().await;
        let app = test_app_with(|c| c.netcheck_url = Some(target)).await;
        let (status, headers, body) = send(&app, "GET", "/api/network/stats", false).await;
        assert_eq!(status, StatusCode::OK);
        assert!(headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("application/json"));
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(sorted_paths(&v), NET_SCHEMA, "network schema drifted — update docs");
        assert_eq!(v["schema"], 1);
        assert_eq!(v["online"], true);
        assert!(v["online"].is_boolean());
        let ms = v["latency_ms"].as_f64().expect("latency when online");
        assert!((0.0..10_000.0).contains(&ms), "latency {ms}");
        assert!(v["sampled_at_ms"].as_u64().unwrap() > 1_600_000_000_000);
    }

    #[tokio::test]
    async fn network_stats_unreachable_target_is_offline_null_latency() {
        // A port with nothing listening → connection refused.
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        let app = test_app_with(|c| c.netcheck_url = Some(format!("http://{addr}/"))).await;
        let v = get_json(&app, "/api/network/stats").await;
        assert_eq!(v["online"], false);
        assert!(v["latency_ms"].is_null());
        assert!(v["online"].is_boolean());
    }

    #[tokio::test]
    async fn network_stats_disabled_check_is_offline() {
        let app = test_app().await; // netcheck_url = None
        let v = get_json(&app, "/api/network/stats").await;
        assert_eq!(sorted_paths(&v), NET_SCHEMA);
        assert_eq!(v["online"], false);
        assert!(v["latency_ms"].is_null());
    }

    #[tokio::test]
    async fn network_stats_ignores_parameters_and_rejects_writes() {
        let target = local_ok_server().await;
        let app = test_app_with(|c| c.netcheck_url = Some(target)).await;
        let plain = get_json(&app, "/api/network/stats").await;
        // A destination in the query string must be ignored, not probed.
        let (status, _, body) = send(&app, "GET", "/api/network/stats?url=http://169.254.169.254/&host=evil.example&port=22&target=127.0.0.1", false).await;
        assert_eq!(status, StatusCode::OK);
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(sorted_paths(&v), sorted_paths(&plain));
        let text = String::from_utf8_lossy(&body);
        assert!(!text.contains("169.254") && !text.contains("evil.example") && !text.contains(":22"), "{text}");
        for m in ["POST", "PUT", "PATCH", "DELETE"] {
            let (s, _, _) = send(&app, m, "/api/network/stats", false).await;
            assert_eq!(s, StatusCode::FORBIDDEN, "{m} without X-LTF-Client");
            let (s, _, _) = send(&app, m, "/api/network/stats", true).await;
            assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED, "{m} with X-LTF-Client");
        }
    }

    #[tokio::test]
    async fn network_stats_expose_no_sensitive_network_information() {
        let target = local_ok_server().await;
        let app = test_app_with(|c| c.netcheck_url = Some(target)).await;
        let v = settled_net(&app).await;
        // Only numbers/booleans — no strings at all (no IPs, hosts, ifaces, SSIDs).
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
        assert!(strings.is_empty(), "network stats must contain no strings: {strings:?}");
    }

    #[tokio::test]
    async fn network_stats_rapid_requests_do_not_re_probe() {
        // A counting local server: each accepted connection increments a counter.
        use std::sync::atomic::{AtomicUsize, Ordering as O};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        static HITS: AtomicUsize = AtomicUsize::new(0);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                HITS.fetch_add(1, O::Relaxed);
                tokio::spawn(async move {
                    let mut b = [0u8; 512];
                    let _ = sock.read(&mut b).await;
                    let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").await;
                });
            }
        });
        let app = test_app_with(|c| c.netcheck_url = Some(format!("http://{addr}/"))).await;
        for _ in 0..25 {
            let (s, _, _) = send(&app, "GET", "/api/network/stats", false).await;
            assert_eq!(s, StatusCode::OK);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        // 25 requests within MIN_REFRESH (20s) → exactly one real probe.
        assert_eq!(HITS.load(O::Relaxed), 1, "rapid requests must share a single probe");
    }

    async fn settled_net(app: &TestApp) -> Value {
        get_json(app, "/api/network/stats").await
    }

    async fn status_with_host(app: &TestApp, host: Option<&str>, uri: &str) -> StatusCode {
        let mut req = Request::builder().uri(uri);
        if let Some(h) = host {
            req = req.header(header::HOST, h);
        }
        app.router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap().status()
    }

    #[tokio::test]
    async fn host_policy_accepts_legitimate_hosts_on_every_route_kind() {
        let app = test_app_with(|c| c.allowed_hosts = vec!["orion.home.lan".into()]).await;
        for host in ["localhost", "localhost:8080", "127.0.0.1:8080", "192.168.1.20:8080", "[::1]:8080", "orion.home.lan", "ORION.home.lan:443"] {
            for uri in ["/api/ping", "/", "/js/app.js"] {
                assert_eq!(status_with_host(&app, Some(host), uri).await, StatusCode::OK, "{host} {uri}");
            }
        }
    }

    #[tokio::test]
    async fn host_policy_rejects_arbitrary_misleading_and_malformed_hosts() {
        let app = test_app_with(|c| c.allowed_hosts = vec!["orion.home.lan".into()]).await;
        for host in [
            "evil.example", "evil.example:8080", "localhost.evil.example:8080", "evil.localhost:8080",
            "blocks.pkg.localhost:8080", "orion.home.lan.evil.example", "0.0.0.0:8080", "127.1:8080",
            "user@localhost", "localhost:99999", "localhost:", "[::1",
        ] {
            // Every surface: JSON API, static shell, web layer, event socket.
            for uri in ["/api/ping", "/api/files", "/", "/api/web/inspect?url=https://example.com", "/ws"] {
                assert_eq!(status_with_host(&app, Some(host), uri).await, StatusCode::FORBIDDEN, "{host} {uri}");
            }
        }
        assert_eq!(status_with_host(&app, None, "/api/ping").await, StatusCode::FORBIDDEN, "missing Host");
        // HTTP/2-style absolute authority that disagrees with Host is refused.
        let req = Request::builder().uri("http://evil.example/api/ping").header(header::HOST, "localhost:8080").body(Body::empty()).unwrap();
        assert_eq!(app.router.clone().oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);
    }

    // ── /ws Origin policy: real server, raw handshake, real frames ──────────

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    /// Serve `app` on an ephemeral loopback port (the TestApp keeps its data dir alive).
    async fn live(app: &TestApp) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = app.router.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await;
        });
        addr
    }

    /// Send a WebSocket upgrade; return the HTTP status and, on 101, the stream.
    async fn ws_handshake(addr: std::net::SocketAddr, host: &str, origin: Option<&str>) -> (u16, Option<TcpStream>) {
        ws_handshake_with(addr, host, origin, None).await
    }

    async fn ws_handshake_with(addr: std::net::SocketAddr, host: &str, origin: Option<&str>, cookie: Option<&str>) -> (u16, Option<TcpStream>) {
        let mut sock = TcpStream::connect(addr).await.unwrap();
        let mut req = format!(
            "GET /ws HTTP/1.1\r\nHost: {host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        );
        if let Some(o) = origin {
            req.push_str(&format!("Origin: {o}\r\n"));
        }
        if let Some(c) = cookie {
            req.push_str(&format!("Cookie: {c}\r\n"));
        }
        req.push_str("\r\n");
        sock.write_all(req.as_bytes()).await.unwrap();
        let mut head = Vec::new();
        let mut b = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            let n = tokio::time::timeout(std::time::Duration::from_secs(5), sock.read(&mut b)).await.expect("timeout").unwrap();
            if n == 0 { break; }
            head.push(b[0]);
        }
        let text = String::from_utf8_lossy(&head);
        let status: u16 = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        (status, (status == 101).then_some(sock))
    }

    /// Read one server frame (unmasked); returns (opcode, payload).
    async fn read_frame(sock: &mut TcpStream) -> (u8, Vec<u8>) {
        let mut h = [0u8; 2];
        tokio::time::timeout(std::time::Duration::from_secs(5), sock.read_exact(&mut h)).await.expect("timeout").unwrap();
        let mut len = (h[1] & 0x7f) as u64;
        if len == 126 {
            let mut e = [0u8; 2];
            sock.read_exact(&mut e).await.unwrap();
            len = u16::from_be_bytes(e) as u64;
        } else if len == 127 {
            let mut e = [0u8; 8];
            sock.read_exact(&mut e).await.unwrap();
            len = u64::from_be_bytes(e);
        }
        let mut payload = vec![0u8; len as usize];
        sock.read_exact(&mut payload).await.unwrap();
        (h[0] & 0x0f, payload)
    }

    /// Send a masked client text frame (short payloads only).
    async fn send_text(sock: &mut TcpStream, text: &str) {
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        let mut f = vec![0x81, 0x80 | text.len() as u8];
        f.extend_from_slice(&mask);
        f.extend(text.bytes().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        sock.write_all(&f).await.unwrap();
    }

    #[tokio::test]
    async fn ws_same_origin_is_accepted_and_still_works() {
        let app = test_app().await;
        let addr = live(&app).await;
        let host = format!("127.0.0.1:{}", addr.port());
        let (status, sock) = ws_handshake(addr, &host, Some(&format!("http://{host}"))).await;
        assert_eq!(status, 101, "same-origin upgrade must succeed");
        let mut sock = sock.unwrap();
        let (op, hello) = read_frame(&mut sock).await;
        assert_eq!(op, 1);
        assert!(String::from_utf8_lossy(&hello).contains("\"hello\""), "greeting frame");
        send_text(&mut sock, r#"{"type":"ping"}"#).await;
        let mut got_pong = false;
        for _ in 0..5 {
            let (_, p) = read_frame(&mut sock).await;
            if String::from_utf8_lossy(&p).contains("pong") { got_pong = true; break; }
        }
        assert!(got_pong, "ping → pong still works");
        // The localhost form of the same origin is equally accepted.
        let lh = format!("localhost:{}", addr.port());
        assert_eq!(ws_handshake(addr, &lh, Some(&format!("http://{lh}"))).await.0, 101);
    }

    #[tokio::test]
    async fn ws_rejects_foreign_null_missing_and_misleading_origins() {
        let app = test_app().await;
        let addr = live(&app).await;
        let port = addr.port();
        let host = format!("127.0.0.1:{port}");
        for origin in [
            Some("https://evil.example".to_string()),
            Some("null".to_string()),
            None,
            Some(format!("http://127.0.0.1.evil.example:{port}")),
            Some(format!("http://localhost:{port}@evil.example")),
            Some(format!("http://127.0.0.1:{}", port.wrapping_add(1))),
            Some(format!("http://localhost:{port}")),       // different origin than 127.0.0.1
            Some(format!("https://127.0.0.1:{port}/path")),
            Some(format!("ws://127.0.0.1:{port}")),
        ] {
            let (status, sock) = ws_handshake(addr, &host, origin.as_deref()).await;
            assert_eq!(status, 403, "origin {origin:?} must be refused before upgrade");
            assert!(sock.is_none());
        }
        // DNS-rebinding shape: attacker hostname as both Host and Origin.
        let evil = format!("evil.example:{port}");
        assert_eq!(ws_handshake(addr, &evil, Some(&format!("http://{evil}"))).await.0, 403);
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
        assert_eq!(info["name"], "Orion OS");
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

    // ── Production mode: deployment config, access gate, Host/Origin ──

    const BETA_HOST: &str = "beta.orion.test";
    const BETA_KEY: &str = "correct-horse-battery-staple-42";

    fn beta(c: &mut Config) {
        c.mode = config::Mode::Production;
        c.allowed_hosts = vec![BETA_HOST.into()];
        c.access_key = Some(config::Secret::new(BETA_KEY.into()));
    }

    /// Build a request against the beta host with optional Origin/Cookie/body.
    async fn beta_req(app: &TestApp, method: &str, uri: &str, origin: Option<&str>, cookie: Option<&str>, form: Option<&str>, accept_html: bool) -> (StatusCode, header::HeaderMap, String) {
        let mut req = Request::builder().method(method).uri(uri).header(header::HOST, BETA_HOST);
        if let Some(o) = origin { req = req.header(header::ORIGIN, o); }
        if let Some(c) = cookie { req = req.header(header::COOKIE, c); }
        if accept_html { req = req.header(header::ACCEPT, "text/html,application/xhtml+xml"); }
        let body = match form {
            Some(f) => { req = req.header(header::CONTENT_TYPE, "application/x-www-form-urlencoded"); Body::from(f.to_string()) }
            None => Body::empty(),
        };
        let res = app.router.clone().oneshot(req.body(body).unwrap()).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        let body = String::from_utf8_lossy(&to_bytes(res.into_body(), usize::MAX).await.unwrap()).into_owned();
        (status, headers, body)
    }

    const BETA_ORIGIN: &str = "https://beta.orion.test";

    /// Sign in; returns the `name=value` cookie pair.
    async fn sign_in(app: &TestApp) -> String {
        let (s, h, _) = beta_req(app, "POST", "/login", Some(BETA_ORIGIN), None, Some(&format!("key={BETA_KEY}")), true).await;
        assert_eq!(s, StatusCode::SEE_OTHER);
        assert_eq!(h[header::LOCATION], "/");
        h[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_string()
    }

    #[tokio::test]
    async fn beta_config_fails_closed() {
        let mut ok = Config::from_env();
        beta(&mut ok);
        assert!(ok.validate().is_ok(), "{:?}", ok.validate());
        assert_eq!(Config::from_env().validate(), Ok(()), "development defaults stay valid");

        let mut c = ok.clone();
        c.access_key = None;
        assert!(c.validate().unwrap_err().contains("LTF_ACCESS_KEY"));
        let mut c = ok.clone();
        c.access_key = Some(config::Secret::new("short".into()));
        assert!(c.validate().unwrap_err().contains("at least"));
        let mut c = ok.clone();
        c.allowed_hosts = vec![];
        assert!(c.validate().unwrap_err().contains("LTF_ALLOWED_HOSTS"));
        let mut c = ok.clone();
        c.allowed_hosts = vec!["*.orion.test".into(), "beta.orion.test:443".into()]; // invalid entries don't count
        assert!(c.validate().unwrap_err().contains("LTF_ALLOWED_HOSTS"));
        let mut c = ok.clone();
        c.proxy_allow_private = true;
        assert!(c.validate().unwrap_err().contains("LTF_PROXY_ALLOW_PRIVATE"));
        // The key never shows up when the config is debug-printed.
        assert!(!format!("{ok:?}").contains(BETA_KEY));
        assert!(ok.secure_cookies());
    }

    #[tokio::test]
    async fn beta_rejects_unauthenticated_access_on_every_surface() {
        let app = test_app_with(beta).await;
        for uri in ["/api/ping", "/api/files", "/api/prefs", "/api/system/stats", "/api/web/inspect?url=https://example.com", "/net/x", "/proxy/page?url=https://example.com", "/js/app.js", "/apps.json", "/sw.js", "/ws"] {
            let (s, h, body) = beta_req(&app, "GET", uri, None, None, None, false).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED, "{uri}");
            assert_eq!(h[header::CACHE_CONTROL], "no-store", "{uri}");
            assert!(body.contains("UNAUTHENTICATED"), "{uri}: {body}");
        }
        // Browser navigation → sign-in page (401, not a redirect), unframeable, uncached, no shell source.
        for uri in ["/", "/index.html", "/apps/playground/"] {
            let (s, h, body) = beta_req(&app, "GET", uri, None, None, None, true).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED, "{uri}");
            assert!(body.contains("action=\"/login\"") && !body.contains("js/app.js"), "{uri}");
            assert!(h[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("frame-ancestors 'none'"));
            assert_eq!(h[header::X_FRAME_OPTIONS], "DENY");
            assert_eq!(h[header::CACHE_CONTROL], "no-store");
        }
        // Writes too.
        let (s, _, _) = beta_req(&app, "POST", "/api/prefs/reset", Some(BETA_ORIGIN), None, None, false).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        // Health check stays public and says nothing else.
        let (s, _, body) = beta_req(&app, "GET", "/healthz", None, None, None, false).await;
        assert_eq!((s, body.as_str()), (StatusCode::OK, "ok"));
    }

    #[tokio::test]
    async fn beta_sign_in_works_and_cookie_is_hardened() {
        let app = test_app_with(beta).await;
        // "Keep me signed in" → persistent cookie for LTF_SESSION_HOURS (default 7 days).
        let (s, h, _) = beta_req(&app, "POST", "/login", Some(BETA_ORIGIN), None, Some(&format!("key={BETA_KEY}&remember=1")), true).await;
        assert_eq!(s, StatusCode::SEE_OTHER);
        let set = h[header::SET_COOKIE].to_str().unwrap();
        for attr in ["__Host-orion_session=", "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=604800"] {
            assert!(set.contains(attr), "cookie missing {attr}: {set}");
        }
        assert!(!set.contains("Domain"), "__Host- cookies must not set Domain");
        assert!(!set.contains(BETA_KEY), "cookie must not contain the key");
        let cookie = set.split(';').next().unwrap();
        // Authenticated access works everywhere.
        for uri in ["/api/ping", "/api/files", "/js/app.js", "/api/session"] {
            let (s, _, _) = beta_req(&app, "GET", uri, None, Some(cookie), None, false).await;
            assert_eq!(s, StatusCode::OK, "{uri}");
        }
        let (s, _, body) = beta_req(&app, "GET", "/", None, Some(cookie), None, true).await;
        assert_eq!(s, StatusCode::OK);
        assert!(body.contains("js/app.js"), "the real shell is served once signed in");
        let (_, _, body) = beta_req(&app, "GET", "/api/session", None, Some(cookie), None, false).await;
        assert_eq!(body, r#"{"access_control":true}"#);
        // CSRF guard still applies to signed-in writes.
        let (s, _, _) = beta_req(&app, "POST", "/api/prefs/reset", Some(BETA_ORIGIN), Some(cookie), None, false).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        // Already signed in → /login bounces home.
        let (s, _, _) = beta_req(&app, "GET", "/login", None, Some(cookie), None, true).await;
        assert_eq!(s, StatusCode::SEE_OTHER);
    }

    #[tokio::test]
    async fn beta_sign_in_rejects_wrong_keys_foreign_origins_and_urls() {
        let app = test_app_with(beta).await;
        for form in ["key=wrong-key-wrong-key", "key=", "", &format!("key={BETA_KEY}x"), &format!("key={}", &BETA_KEY[..BETA_KEY.len() - 1])] {
            let (s, h, body) = beta_req(&app, "POST", "/login", Some(BETA_ORIGIN), None, Some(form), true).await;
            assert!(s == StatusCode::UNAUTHORIZED || s == StatusCode::BAD_REQUEST, "{form}: {s}");
            assert!(h.get(header::SET_COOKIE).is_none(), "{form}");
            assert!(!body.contains(BETA_KEY), "error page must not echo the key");
        }
        // The key in a URL is never accepted.
        let (s, h, _) = beta_req(&app, "POST", &format!("/login?key={BETA_KEY}"), Some(BETA_ORIGIN), None, None, true).await;
        assert!(s != StatusCode::SEE_OTHER && h.get(header::SET_COOKIE).is_none());
        let (s, _, _) = beta_req(&app, "GET", &format!("/api/ping?key={BETA_KEY}"), None, None, None, false).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        // Correct key, but cross-site / null / missing Origin → refused (login CSRF).
        for origin in [Some("https://evil.example"), Some("null"), None, Some("http://beta.orion.test:8443"), Some("http://beta.orion.test"), Some("https://beta.orion.test.evil.example")] {
            let (s, h, _) = beta_req(&app, "POST", "/login", origin, None, Some(&format!("key={BETA_KEY}")), true).await;
            assert_eq!(s, StatusCode::FORBIDDEN, "{origin:?}");
            assert!(h.get(header::SET_COOKIE).is_none());
        }
    }

    #[tokio::test]
    async fn beta_sign_in_is_rate_limited() {
        let app = test_app_with(beta).await;
        let mut limited = false;
        for _ in 0..15 {
            let (s, _, _) = beta_req(&app, "POST", "/login", Some(BETA_ORIGIN), None, Some("key=guess-guess-guess-guess"), true).await;
            if s == StatusCode::TOO_MANY_REQUESTS { limited = true; break; }
        }
        assert!(limited, "repeated failures must be throttled");
        // …and while throttled even the right key doesn't get through.
        let (s, h, _) = beta_req(&app, "POST", "/login", Some(BETA_ORIGIN), None, Some(&format!("key={BETA_KEY}")), true).await;
        assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
        assert!(h.get(header::SET_COOKIE).is_none());
    }

    #[tokio::test]
    async fn beta_tampered_foreign_and_signed_out_sessions_are_rejected() {
        let app = test_app_with(beta).await;
        let cookie = sign_in(&app).await;
        let (name, value) = cookie.split_once('=').unwrap();
        let flipped = {
            let mut v = value.to_string();
            let c = if v.ends_with('A') { 'B' } else { 'A' };
            v.pop();
            v.push(c);
            v
        };
        let far_future = value.replacen(&value.split('.').nth(1).unwrap().to_string(), "99999999999", 1);
        for bad in [
            format!("{name}={flipped}"),
            format!("{name}={far_future}"),
            format!("{name}=v1.99999999999.AAAA.AAAA"),
            format!("orion_session={value}"), // wrong (non-__Host-) cookie name in beta
            format!("{name}="),
        ] {
            let (s, _, _) = beta_req(&app, "GET", "/api/ping", None, Some(&bad), None, false).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED, "{bad}");
        }
        // A session minted under another key is worthless here.
        let other = test_app_with(|c| { beta(c); c.access_key = Some(config::Secret::new("a-completely-different-key".into())); }).await;
        let (s, _, _) = beta_req(&other, "GET", "/api/ping", None, Some(&cookie), None, false).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        // Sign-out: cross-origin refused; same-origin revokes and expires the cookie.
        let (s, _, _) = beta_req(&app, "POST", "/logout", Some("https://evil.example"), Some(&cookie), None, false).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        assert_eq!(beta_req(&app, "GET", "/api/ping", None, Some(&cookie), None, false).await.0, StatusCode::OK);
        let (s, h, _) = beta_req(&app, "POST", "/logout", Some(BETA_ORIGIN), Some(&cookie), None, false).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        assert!(h[header::SET_COOKIE].to_str().unwrap().contains("Max-Age=0"));
        let (s, _, _) = beta_req(&app, "GET", "/api/ping", None, Some(&cookie), None, false).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "a copied cookie stops working after sign-out");
    }

    #[tokio::test]
    async fn beta_host_policy_is_unchanged_and_runs_before_auth() {
        let app = test_app_with(beta).await;
        let cookie = sign_in(&app).await;
        let with = |host: &'static str| {
            let app = &app;
            let cookie = cookie.clone();
            async move {
                let req = Request::builder().uri("/api/ping").header(header::HOST, host).header(header::COOKIE, cookie).body(Body::empty()).unwrap();
                app.router.clone().oneshot(req).await.unwrap().status()
            }
        };
        // Trusted: the configured beta host (any port, any case), localhost and IP literals.
        for host in ["beta.orion.test", "BETA.orion.test:443", "beta.orion.test:8443", "localhost:8080", "127.0.0.1:8080", "[::1]:8080"] {
            assert_eq!(with(host).await, StatusCode::OK, "{host}");
        }
        // Untrusted / misleading / malformed hosts are refused even with a valid session.
        for host in ["evil.example", "beta.orion.test.evil.example", "x.beta.orion.test", "orion.test", "evil.localhost", "beta.orion.test:", "user@beta.orion.test", "beta.orion.test/x", "0.0.0.0"] {
            assert_eq!(with(host).await, StatusCode::FORBIDDEN, "{host}");
        }
        // Host is checked first: an unauthenticated request with a bad Host gets 403, not the sign-in page.
        let req = Request::builder().uri("/").header(header::HOST, "evil.example").header(header::ACCEPT, "text/html").body(Body::empty()).unwrap();
        assert_eq!(app.router.clone().oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);
        // HTTP/2-style authority disagreeing with Host is still refused.
        let req = Request::builder().uri("https://evil.example/api/ping").header(header::HOST, BETA_HOST).header(header::COOKIE, cookie.as_str()).body(Body::empty()).unwrap();
        assert_eq!(app.router.clone().oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);
        // HTTP/2 with only an authority (no Host header) is judged by the authority.
        let req = Request::builder().uri("https://beta.orion.test/api/ping").header(header::COOKIE, cookie.as_str()).body(Body::empty()).unwrap();
        assert_eq!(app.router.clone().oneshot(req).await.unwrap().status(), StatusCode::OK);
        let req = Request::builder().uri("https://evil.example/api/ping").header(header::COOKIE, cookie.as_str()).body(Body::empty()).unwrap();
        assert_eq!(app.router.clone().oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn beta_ws_requires_session_and_same_origin() {
        let app = test_app_with(beta).await;
        let cookie = sign_in(&app).await;
        let addr = live(&app).await;
        // What a reverse proxy forwards for https://beta.orion.test: Host preserved, Origin from the browser.
        let (status, sock) = ws_handshake_with(addr, BETA_HOST, Some(BETA_ORIGIN), Some(&cookie)).await;
        assert_eq!(status, 101, "signed-in same-origin upgrade through the proxy shape");
        let mut sock = sock.unwrap();
        let (_, hello) = read_frame(&mut sock).await;
        assert!(String::from_utf8_lossy(&hello).contains("\"hello\""));
        send_text(&mut sock, r#"{"type":"ping"}"#).await;
        let mut got_pong = false;
        for _ in 0..5 {
            let (_, p) = read_frame(&mut sock).await;
            if String::from_utf8_lossy(&p).contains("pong") { got_pong = true; break; }
        }
        assert!(got_pong);
        // Non-default public port (e.g. :8443) works when the proxy forwards it in Host.
        let h = "beta.orion.test:8443";
        assert_eq!(ws_handshake_with(addr, h, Some("https://beta.orion.test:8443"), Some(&cookie)).await.0, 101);
        // No session → 401 before upgrade, even from the right origin.
        assert_eq!(ws_handshake_with(addr, BETA_HOST, Some(BETA_ORIGIN), None).await.0, 401);
        // Session present but foreign / null / missing / look-alike Origin → 403.
        for origin in [Some("https://evil.example"), Some("null"), None, Some("https://beta.orion.test.evil.example"), Some("https://beta.orion.test:8443"), Some("http://beta.orion.test"), Some("http://beta.orion.test:443")] {
            assert_eq!(ws_handshake_with(addr, BETA_HOST, origin, Some(&cookie)).await.0, 403, "{origin:?}");
        }
        // Untrusted Host → 403 regardless of session or matching Origin.
        assert_eq!(ws_handshake_with(addr, "evil.example", Some("https://evil.example"), Some(&cookie)).await.0, 403);
        // Malformed Host → refused (400 from the HTTP parser or 403 from the policy).
        let s = ws_handshake_with(addr, "beta.orion.test:99999", Some(BETA_ORIGIN), Some(&cookie)).await.0;
        assert!(s == 400 || s == 403, "{s}");
    }

    #[tokio::test]
    async fn beta_ws_closes_when_the_session_is_signed_out() {
        let app = test_app_with(beta).await;
        let cookie = sign_in(&app).await;
        let addr = live(&app).await;
        let (status, sock) = ws_handshake_with(addr, BETA_HOST, Some(BETA_ORIGIN), Some(&cookie)).await;
        assert_eq!(status, 101);
        let mut sock = sock.unwrap();
        let _hello = read_frame(&mut sock).await;
        let (s, _, _) = beta_req(&app, "POST", "/logout", Some(BETA_ORIGIN), Some(&cookie), None, false).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        // The socket's periodic re-check closes it (≤ 15 s); skip unrelated event frames.
        let closed = tokio::time::timeout(std::time::Duration::from_secs(20), async {
            loop {
                let mut h = [0u8; 2];
                if sock.read_exact(&mut h).await.is_err() { return true; }
                if h[0] & 0x0f == 8 { return true; }
                let mut rest = vec![0u8; (h[1] & 0x7f) as usize];
                if sock.read_exact(&mut rest).await.is_err() { return true; }
            }
        }).await.unwrap_or(false);
        assert!(closed, "an open event stream must not outlive its sign-in");
    }

    #[tokio::test]
    async fn development_mode_without_a_key_is_unchanged() {
        let app = test_app().await;
        assert_eq!(send(&app, "GET", "/api/ping", false).await.0, StatusCode::OK);
        assert_eq!(get_json(&app, "/api/session").await["access_control"], false);
        let (s, h, _) = send(&app, "GET", "/login", false).await;
        assert_eq!(s, StatusCode::SEE_OTHER, "no sign-in page when the gate is off");
        assert_eq!(h[header::LOCATION], "/");
        let (s, _, body) = send(&app, "GET", "/healthz", false).await;
        assert_eq!((s, body.as_slice()), (StatusCode::OK, b"ok".as_slice()));
        let c = Config::from_env();
        assert_eq!(c.mode, config::Mode::Development);
        assert_eq!(c.bind, std::net::IpAddr::from([0, 0, 0, 0]), "development still binds all interfaces");
        assert!(!c.secure_cookies());
    }

    fn token_expiry(set_cookie: &str) -> u64 {
        let value = set_cookie.split(';').next().unwrap().split_once('=').unwrap().1;
        value.split('.').nth(1).unwrap().parse().unwrap()
    }

    #[tokio::test]
    async fn default_sign_in_is_for_this_browser_session_only() {
        // Shared/school computers: without "Keep me signed in" the cookie has no
        // Max-Age (dropped when the browser closes) and the token lasts ≤ 12 h.
        let app = test_app_with(beta).await;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        for form in [format!("key={BETA_KEY}"), format!("key={BETA_KEY}&remember=0"), format!("key={BETA_KEY}&remember=yes")] {
            let (s, h, _) = beta_req(&app, "POST", "/login", Some(BETA_ORIGIN), None, Some(&form), true).await;
            assert_eq!(s, StatusCode::SEE_OTHER, "{form}");
            let set = h[header::SET_COOKIE].to_str().unwrap();
            assert!(!set.contains("Max-Age"), "session-only cookie expected: {set}");
            for attr in ["__Host-orion_session=", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"] {
                assert!(set.contains(attr), "cookie missing {attr}: {set}");
            }
            let exp = token_expiry(set);
            assert!(exp > now && exp <= now + 12 * 3600 + 5, "token must expire within 12 h: {exp} vs {now}");
        }
        let (_, h, _) = beta_req(&app, "POST", "/login", Some(BETA_ORIGIN), None, Some(&format!("key={BETA_KEY}&remember=1")), true).await;
        let exp = token_expiry(h[header::SET_COOKIE].to_str().unwrap());
        assert!(exp > now + 7 * 24 * 3600 - 5, "remembered sign-in lasts LTF_SESSION_HOURS");
        // A short LTF_SESSION_HOURS also caps the browser-session token.
        let short = test_app_with(|c| { beta(c); c.session_hours = 2; }).await;
        let (_, h, _) = beta_req(&short, "POST", "/login", Some(BETA_ORIGIN), None, Some(&format!("key={BETA_KEY}")), true).await;
        assert!(token_expiry(h[header::SET_COOKIE].to_str().unwrap()) <= now + 2 * 3600 + 5);
        // The sign-in page offers the choice, unticked by default.
        let (_, _, page) = beta_req(&app, "GET", "/", None, None, None, true).await;
        assert!(page.contains(r#"name="remember" value="1">"#) && !page.contains("checked"));
    }

    #[tokio::test]
    async fn sign_out_can_erase_this_browsers_data() {
        let app = test_app_with(beta).await;
        let cookie = sign_in(&app).await;
        let (s, h, _) = beta_req(&app, "POST", "/logout", Some(BETA_ORIGIN), Some(&cookie), None, false).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        assert!(h.get("clear-site-data").is_none(), "plain sign-out keeps local data");
        let cookie = sign_in(&app).await;
        let (s, h, _) = beta_req(&app, "POST", "/logout?erase=1", Some(BETA_ORIGIN), Some(&cookie), None, false).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        assert_eq!(h["clear-site-data"], r#""cache", "storage""#);
        assert!(h[header::SET_COOKIE].to_str().unwrap().contains("Max-Age=0"));
        assert_eq!(beta_req(&app, "GET", "/api/ping", None, Some(&cookie), None, false).await.0, StatusCode::UNAUTHORIZED);
        // Still same-origin only.
        let (s, h, _) = beta_req(&app, "POST", "/logout?erase=1", Some("https://evil.example"), None, None, false).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        assert!(h.get("clear-site-data").is_none());
    }

    #[test]
    fn mode_names() {
        assert_eq!(config::parse_mode(None), Ok(config::Mode::Development));
        assert_eq!(config::parse_mode(Some("development")), Ok(config::Mode::Development));
        assert_eq!(config::parse_mode(Some("production")), Ok(config::Mode::Production));
        assert_eq!(config::parse_mode(Some("beta")), Ok(config::Mode::Production), "old name still works");
        assert!(config::parse_mode(Some("prod")).is_err());
        assert!(config::parse_mode(Some("public")).is_err());
    }
}
