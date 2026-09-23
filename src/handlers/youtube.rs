//! `/api/youtube/search` — thin wrapper over the YouTube Data API v3.
//! The key stays on the server (`YOUTUBE_API_KEY`); playback uses the
//! official embed player, so no proxying is involved.

use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    error::{ApiError, ApiResult},
    state::SharedState,
};

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
    #[serde(default)]
    pub page: Option<String>,
}

pub async fn search(State(state): State<SharedState>, Query(sq): Query<SearchQuery>) -> ApiResult<Json<Value>> {
    let key = state
        .config
        .youtube_api_key
        .as_deref()
        .ok_or_else(|| ApiError::Unavailable("YouTube search is not configured (set YOUTUBE_API_KEY).".into()))?;
    let q = sq.q.trim();
    if q.is_empty() || q.len() > 200 {
        return Err(ApiError::BadRequest("query must be 1–200 characters".into()));
    }
    let mut params = vec![
        ("part", "snippet"),
        ("type", "video"),
        ("videoEmbeddable", "true"),
        ("maxResults", "24"),
        ("safeSearch", "moderate"),
        ("q", q),
        ("key", key),
    ];
    if let Some(p) = sq.page.as_deref() {
        params.push(("pageToken", p));
    }
    let resp = state
        .http
        .get("https://www.googleapis.com/youtube/v3/search")
        .query(&params)
        .send()
        .await
        .map_err(|e| ApiError::Upstream(e.to_string()))?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| ApiError::Upstream(e.to_string()))?;
    if !status.is_success() {
        let msg = body["error"]["message"].as_str().unwrap_or("YouTube API error").to_string();
        return Err(ApiError::Upstream(msg));
    }
    let items: Vec<Value> = body["items"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|it| {
                    let s = &it["snippet"];
                    Some(json!({
                        "id": it["id"]["videoId"].as_str()?,
                        "title": s["title"],
                        "channel": s["channelTitle"],
                        "published": s["publishedAt"],
                        "thumbnail": s["thumbnails"]["high"]["url"].as_str().or(s["thumbnails"]["medium"]["url"].as_str()),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(json!({ "items": items, "next": body["nextPageToken"] })))
}
