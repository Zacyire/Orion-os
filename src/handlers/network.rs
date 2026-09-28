use axum::{
    extract::State,
    http::{header, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};

use crate::state::SharedState;

/// `GET /api/network/stats` — read-only server-side connectivity/latency for
/// first-party desktop UI. Fixed schema, no parameters: nothing in the request
/// selects a destination (see src/netstats.rs and docs/system-stats.md).
///
/// `latency_ms` is the Orion OS **server's** round-trip to a fixed, server-configured
/// endpoint — not the user's browser ping. A real probe runs at most once per
/// `netstats::MIN_REFRESH`; requests in between share the cached snapshot.
pub async fn stats(State(state): State<SharedState>) -> Response {
    state.netstats.refresh_if_due().await;
    let mut res = Json(state.netstats.snapshot()).into_response();
    // Live data: never cache.
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}
