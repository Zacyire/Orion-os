//! Document storage for Notepad / Files. Flat directory, sanitised names.

use std::{path::PathBuf, time::UNIX_EPOCH};

use axum::{
    body::Bytes,
    extract::{Multipart, Path, State},
    http::header,
    response::IntoResponse,
    Json,
};
use serde_json::{json, Value};

use crate::{
    error::{ApiError, ApiResult},
    state::SharedState,
};

const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;

/// Reject anything that could escape the files directory.
fn sanitize(name: &str) -> ApiResult<String> {
    let name = name.trim();
    let ok = !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '));
    if ok {
        Ok(name.to_string())
    } else {
        Err(ApiError::BadRequest(format!("invalid file name '{name}'")))
    }
}

fn path_for(state: &SharedState, name: &str) -> ApiResult<PathBuf> {
    Ok(state.files_dir.join(sanitize(name)?))
}

pub async fn list(State(state): State<SharedState>) -> ApiResult<Json<Vec<Value>>> {
    let mut out = Vec::new();
    let mut dir = tokio::fs::read_dir(&state.files_dir).await?;
    while let Some(entry) = dir.next_entry().await? {
        let meta = entry.metadata().await?;
        if !meta.is_file() {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "size": meta.len(),
            "modified": modified,
        }));
    }
    out.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));
    Ok(Json(out))
}

pub async fn read(State(state): State<SharedState>, Path(name): Path<String>) -> ApiResult<impl IntoResponse> {
    let content = tokio::fs::read_to_string(path_for(&state, &name)?).await?;
    Ok(([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], content))
}

pub async fn write(
    State(state): State<SharedState>,
    Path(name): Path<String>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    if body.len() > MAX_FILE_BYTES {
        return Err(ApiError::BadRequest("file too large (5 MB max)".into()));
    }
    let path = path_for(&state, &name)?;
    tokio::fs::write(&path, &body).await?;
    state.emit("file-changed", json!({ "name": name }));
    Ok(Json(json!({ "name": name, "size": body.len() })))
}

pub async fn remove(State(state): State<SharedState>, Path(name): Path<String>) -> ApiResult<Json<Value>> {
    tokio::fs::remove_file(path_for(&state, &name)?).await?;
    state.emit("file-changed", json!({ "name": name, "deleted": true }));
    Ok(Json(json!({ "name": name, "deleted": true })))
}

pub async fn download(State(state): State<SharedState>, Path(name): Path<String>) -> ApiResult<impl IntoResponse> {
    let safe = sanitize(&name)?;
    let bytes = tokio::fs::read(state.files_dir.join(&safe)).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{safe}\"")),
        ],
        bytes,
    ))
}

/// `multipart/form-data` upload; every `file` field is stored.
pub async fn upload(State(state): State<SharedState>, mut form: Multipart) -> ApiResult<Json<Vec<Value>>> {
    let mut saved = Vec::new();
    while let Some(field) = form.next_field().await.map_err(|e| ApiError::BadRequest(e.to_string()))? {
        let Some(name) = field.file_name().map(str::to_owned) else { continue };
        let name = sanitize(&name)?;
        let data = field.bytes().await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
        if data.len() > MAX_FILE_BYTES {
            return Err(ApiError::BadRequest(format!("'{name}' is too large (5 MB max)")));
        }
        tokio::fs::write(state.files_dir.join(&name), &data).await?;
        saved.push(json!({ "name": name, "size": data.len() }));
    }
    if saved.is_empty() {
        return Err(ApiError::BadRequest("no files in upload".into()));
    }
    state.emit("file-changed", json!({ "uploaded": saved }));
    Ok(Json(saved))
}

#[cfg(test)]
mod tests {
    use super::sanitize;

    #[test]
    fn rejects_traversal() {
        assert!(sanitize("../etc/passwd").is_err());
        assert!(sanitize(".hidden").is_err());
        assert!(sanitize("a/b.txt").is_err());
        assert!(sanitize("").is_err());
        assert!(sanitize("notes 2.md").is_ok());
    }
}
