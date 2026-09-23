//! Creator-managed content catalogues, read from `content/<kind>.json` on
//! every request so edits show up without a restart.

use axum::{
    extract::{Path, State},
    Json,
};
use serde_json::{json, Value};

use crate::{
    error::{ApiError, ApiResult},
    state::{read_json, SharedState},
};

const KINDS: &[&str] = &["music", "games", "youtube", "wallpapers"];
const VIDEO_EXT: &[&str] = &["mp4", "webm", "mov", "m4v"];

pub async fn get(State(state): State<SharedState>, Path(kind): Path<String>) -> ApiResult<Json<Value>> {
    if !KINDS.contains(&kind.as_str()) {
        return Err(ApiError::NotFound(format!("unknown content kind '{kind}'")));
    }
    if kind == "wallpapers" {
        return Ok(Json(wallpapers(&state).await));
    }
    let path = state.config.content_dir.join(format!("{kind}.json"));
    Ok(Json(read_json(&path).await.unwrap_or_else(|| json!({ "items": [] }))))
}

/// `content/wallpapers.json` plus any video file dropped into
/// `static/media/wallpapers/` that isn't already listed.
async fn wallpapers(state: &SharedState) -> Value {
    let mut doc = read_json(&state.config.content_dir.join("wallpapers.json"))
        .await
        .unwrap_or_else(|| json!({ "items": [] }));
    let mut items = doc["items"].as_array().cloned().unwrap_or_default();

    let dir = state.config.static_dir.join("media/wallpapers");
    if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
        let mut found = Vec::new();
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
            if !VIDEO_EXT.contains(&ext.as_str()) {
                continue;
            }
            let src = format!("media/wallpapers/{name}");
            if items.iter().any(|i| i["src"] == src) {
                continue;
            }
            let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(&name);
            let poster = ["jpg", "png", "webp"]
                .iter()
                .map(|e| format!("{stem}.{e}"))
                .find(|p| dir.join(p).exists())
                .map(|p| format!("media/wallpapers/{p}"));
            found.push(json!({
                "id": format!("file-{stem}"),
                "name": stem.replace(['-', '_'], " "),
                "type": "video",
                "src": src,
                "poster": poster,
            }));
        }
        found.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        items.extend(found);
    }
    doc["items"] = Value::Array(items);
    doc
}
