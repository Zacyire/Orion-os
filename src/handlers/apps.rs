use axum::{
    extract::{Path, State},
    Json,
};
use serde_json::{json, Value};

use crate::{
    catalog,
    error::{ApiError, ApiResult},
    state::SharedState,
};

/// Full catalogue with an `installed` flag per app.
pub async fn list(State(state): State<SharedState>) -> Json<Vec<Value>> {
    let installed = state.installed.read().await;
    Json(
        catalog::all()
            .iter()
            .map(|app| {
                let mut v = serde_json::to_value(app).unwrap_or_default();
                v["installed"] = json!(app.system || installed.contains(&app.id));
                v
            })
            .collect(),
    )
}

pub async fn install(State(state): State<SharedState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let app = catalog::find(&id).ok_or_else(|| ApiError::NotFound(format!("unknown app '{id}'")))?;
    state.installed.write().await.insert(app.id.clone());
    state.save_installed().await?;
    state.emit("app-installed", json!({ "id": app.id }));
    Ok(Json(json!({ "id": app.id, "installed": true })))
}

pub async fn uninstall(State(state): State<SharedState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let app = catalog::find(&id).ok_or_else(|| ApiError::NotFound(format!("unknown app '{id}'")))?;
    if app.system {
        return Err(ApiError::BadRequest(format!("'{}' is a system app and cannot be removed", app.name)));
    }
    state.installed.write().await.remove(&app.id);
    state.save_installed().await?;
    state.emit("app-uninstalled", json!({ "id": app.id }));
    Ok(Json(json!({ "id": app.id, "installed": false })))
}
