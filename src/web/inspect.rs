//! `GET /api/web/inspect?url=` — preflight used by every app window before
//! it shows a remote page. Answers: is the URL valid and allowed, is the
//! site reachable, where does it redirect to, what content type is it, and
//! does it permit being embedded? Results are cached briefly (per URL) so
//! re-opening an app doesn't cost another round trip.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{client, error::WebError, guard, policy};
use crate::state::SharedState;

const TTL: Duration = Duration::from_secs(300);
const MAX_ENTRIES: usize = 512;

#[derive(Default)]
pub struct InspectCache(Mutex<HashMap<String, (Instant, Value)>>);

impl InspectCache {
    fn get(&self, key: &str) -> Option<Value> {
        let map = self.0.lock().unwrap_or_else(|p| p.into_inner());
        map.get(key).filter(|(t, _)| t.elapsed() < TTL).map(|(_, v)| v.clone())
    }

    fn put(&self, key: String, v: Value) {
        let mut map = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() >= MAX_ENTRIES {
            map.retain(|_, (t, _)| t.elapsed() < TTL);
            if map.len() >= MAX_ENTRIES {
                map.clear();
            }
        }
        map.insert(key, (Instant::now(), v));
    }
}

#[derive(Deserialize)]
pub struct UrlQuery {
    pub url: String,
}

pub async fn handler(State(state): State<SharedState>, headers: HeaderMap, Query(q): Query<UrlQuery>) -> Response {
    if let Some(hit) = state.inspect_cache.get(&q.url) {
        return Json(hit).into_response();
    }
    match inspect(&state, &headers, &q.url).await {
        Ok(v) => {
            state.inspect_cache.put(q.url.clone(), v.clone());
            Json(v).into_response()
        }
        Err(e) => {
            tracing::info!(target: "ltf_os::web", mode = "inspect", url = %truncate(&q.url), code = e.code.as_str(), "{}", e.message);
            e.json()
        }
    }
}

async fn inspect(state: &SharedState, headers: &HeaderMap, raw: &str) -> Result<Value, WebError> {
    let cfg = &state.config;
    let started = Instant::now();
    let target = guard::check(raw, cfg).await?;
    let (final_target, resp) = client::get_following(target, headers, cfg).await?;
    let status = resp.status().as_u16();
    let frame = policy::evaluate(resp.headers());
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    drop(resp); // headers are all we need; don't download the body
    let is_html = content_type.starts_with("text/html") || content_type.starts_with("application/xhtml");
    tracing::info!(
        target: "ltf_os::web", mode = "inspect", host = %final_target.host, status,
        embeddable = frame.embeddable, ms = started.elapsed().as_millis() as u64, "inspected"
    );
    Ok(json!({
        "ok": status < 500,
        "code": if status >= 500 { Some("SITE_UNAVAILABLE") } else { None },
        "url": raw,
        "final_url": final_target.url.as_str(),
        "status": status,
        "content_type": content_type,
        "embeddable": frame.embeddable,
        "blocked_by": frame.blocked_by,
        "isolated_available": cfg.proxy_enabled && frame.embeddable && is_html,
    }))
}

pub fn truncate(s: &str) -> String {
    if s.len() > 120 { format!("{}…", &s[..s.char_indices().nth(120).map(|(i, _)| i).unwrap_or(s.len())]) } else { s.to_string() }
}
