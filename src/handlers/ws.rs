//! WebSocket event bus. Server → client: metrics, prefs, app/file events.
//! Client → server: `{"type":"ping"}` → `{"type":"pong"}`.
//!
//! Origin policy: WebSockets are not covered by CORS, so any web page could
//! otherwise open this socket and read prefs and file names (cross-site
//! WebSocket hijacking). The upgrade is refused — before the connection
//! becomes a WebSocket — unless `Origin` is exactly the origin of this request
//! (`http(s)://<Host>`), and that Host is trusted (src/hosts.rs). `null`,
//! foreign, look-alike and missing origins are all refused. The only consumer
//! is the desktop shell (static/js/core/api.js), a browser page on this same
//! origin, which always sends `Origin`.

use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use crate::state::SharedState;

pub async fn upgrade(State(state): State<SharedState>, uri: Uri, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    if !same_origin(&state, &uri, &headers) {
        return (StatusCode::FORBIDDEN, "cross-origin WebSocket refused").into_response();
    }
    ws.on_upgrade(move |socket| session(socket, state))
}

/// `Origin` must equal the request's own (trusted) origin.
fn same_origin(state: &SharedState, uri: &Uri, headers: &HeaderMap) -> bool {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).or_else(|| uri.authority().map(|a| a.as_str()));
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    match (origin, host) {
        (Some(o), Some(h)) => state.hosts.allows_host_header(h) && crate::hosts::origin_matches_host(o, h),
        _ => false,
    }
}

async fn session(socket: WebSocket, state: SharedState) {
    let (mut tx, mut rx) = socket.split();
    let mut events = state.events.subscribe();

    let hello = json!({ "type": "hello", "data": { "uptime": state.started.elapsed().as_secs() } });
    if tx.send(Message::Text(hello.to_string().into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            ev = events.recv() => match ev {
                Ok(text) => {
                    if tx.send(Message::Text(text.into())).await.is_err() { break; }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            },
            msg = rx.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    let parsed: Value = serde_json::from_str(&text).unwrap_or_default();
                    if parsed["type"] == "ping" {
                        let _ = tx.send(Message::Text(json!({ "type": "pong" }).to_string().into())).await;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
}
