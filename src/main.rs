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
    let static_dir = config.static_dir.clone();
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

    use handlers::*;
    let api = Router::new()
        .route("/system/info", get(system::info))
        .route("/system/boot-log", get(system::boot_log))
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

    let app = Router::new()
        .merge(web_routes)
        .nest("/api", api)
        .route("/ws", get(ws::upgrade))
        .fallback_service(ServeDir::new(&static_dir).append_index_html_on_directories(true))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

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
