//! LTF OS — backend entry point.
//!
//! Serves the static desktop shell from `static/` and exposes the system
//! service API under `/api` plus a WebSocket event bus at `/ws`.

mod catalog;
mod error;
mod handlers;
mod state;

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    routing::{get, post},
    Router,
};
use tower_http::{
    compression::CompressionLayer, cors::CorsLayer, services::ServeDir, trace::TraceLayer,
};
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow_free::Result {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("ltf_os=info,tower_http=warn")),
        )
        .init();

    let data_dir = PathBuf::from(std::env::var("LTF_DATA_DIR").unwrap_or_else(|_| "data".into()));
    let static_dir = PathBuf::from(std::env::var("LTF_STATIC_DIR").unwrap_or_else(|_| "static".into()));
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);

    let state = Arc::new(AppState::load(data_dir).await?);
    state::spawn_metrics_task(state.clone());

    let api = Router::new()
        // system services
        .route("/system/info", get(handlers::system::info))
        .route("/system/stats", get(handlers::system::stats))
        .route("/system/boot-log", get(handlers::system::boot_log))
        .route("/weather", get(handlers::system::weather))
        // user preferences (desktop layout, taskbar, theme, widgets…)
        .route("/prefs", get(handlers::prefs::get_prefs).put(handlers::prefs::put_prefs).patch(handlers::prefs::patch_prefs))
        .route("/prefs/reset", post(handlers::prefs::reset_prefs))
        // app registry / store
        .route("/apps", get(handlers::apps::list))
        .route("/apps/{id}/install", post(handlers::apps::install))
        .route("/apps/{id}", axum::routing::delete(handlers::apps::uninstall))
        // documents (Notepad)
        .route("/files", get(handlers::files::list))
        .route("/files/upload", post(handlers::files::upload))
        .route(
            "/files/{name}",
            get(handlers::files::read).put(handlers::files::write).delete(handlers::files::remove),
        )
        .route("/files/{name}/download", get(handlers::files::download))
        // media + cloud gaming mock data
        .route("/media/tracks", get(handlers::media::tracks))
        .route("/media/videos", get(handlers::media::videos))
        .route("/cloud/games", get(handlers::media::cloud_games))
        .route("/cloud/servers", get(handlers::media::cloud_servers))
        .route("/cloud/session", post(handlers::media::cloud_session));

    let app = Router::new()
        .nest("/api", api)
        .route("/ws", get(handlers::ws::upgrade))
        .fallback_service(ServeDir::new(&static_dir).append_index_html_on_directories(true))
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("LTF OS is up → http://localhost:{port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
        })
        .await?;
    Ok(())
}

/// Tiny boxed-error alias so `main` can use `?` without pulling in anyhow.
mod anyhow_free {
    pub type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
}
