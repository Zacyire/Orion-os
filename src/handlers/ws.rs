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
//!
//! With the access gate on (src/auth.rs), the upgrade also needs
//! a signed-in session, and the stream closes once that session expires or is
//! signed out — an open socket never outlives its sign-in.

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Extension, State, WebSocketUpgrade,
    },
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use crate::state::SharedState;

pub async fn upgrade(
    State(state): State<SharedState>,
    uri: Uri,
    headers: HeaderMap,
    signed_in: Option<Extension<crate::auth::Session>>,
    ws: WebSocketUpgrade,
) -> Response {
    if !same_origin(&state, &uri, &headers) {
        return (StatusCode::FORBIDDEN, "cross-origin WebSocket refused").into_response();
    }
    let signed_in = signed_in.map(|Extension(s)| s);
    if state.gate.is_some() && signed_in.is_none() {
        // Unreachable behind require_access; kept so /ws can never be open by mistake.
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| session(socket, state, signed_in))
}

/// `Origin` must equal the request's own (trusted) origin.
fn same_origin(state: &SharedState, uri: &Uri, headers: &HeaderMap) -> bool {
    crate::hosts::is_same_origin_request(&state.hosts, uri, headers)
}

async fn session(socket: WebSocket, state: SharedState, signed_in: Option<crate::auth::Session>) {
    let (mut tx, mut rx) = socket.split();
    let mut events = state.events.subscribe();
    let mut recheck = tokio::time::interval(std::time::Duration::from_secs(15));

    let hello = json!({ "type": "hello", "data": { "uptime": state.started.elapsed().as_secs() } });
    if tx.send(Message::Text(hello.to_string().into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            _ = recheck.tick() => {
                if let (Some(gate), Some(s)) = (&state.gate, &signed_in) {
                    if !gate.is_live(s) {
                        let _ = tx.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
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
