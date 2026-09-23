//! WebSocket event bus. Server → client: metrics, prefs, app/file events.
//! Client → server: `{"type":"ping"}` → `{"type":"pong"}`.

use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use crate::state::SharedState;

pub async fn upgrade(ws: WebSocketUpgrade, State(state): State<SharedState>) -> Response {
    ws.on_upgrade(move |socket| session(socket, state))
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
