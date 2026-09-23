use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    catalog,
    error::{ApiError, ApiResult},
    state::{CustomApp, SharedState},
};

/// Full catalogue (built-in + creator-added web apps) with an `installed` flag.
pub async fn list(State(state): State<SharedState>) -> Json<Vec<Value>> {
    let installed = state.installed.read().await;
    let mut out: Vec<Value> = catalog::all()
        .iter()
        .map(|app| {
            let mut v = serde_json::to_value(app).unwrap_or_default();
            v["installed"] = json!(app.system || installed.contains(&app.id));
            v
        })
        .collect();
    out.extend(state.custom_apps.read().await.iter().map(custom_to_catalog));
    Json(out)
}

fn custom_to_catalog(c: &CustomApp) -> Value {
    json!({
        "id": c.id, "name": c.name, "module": "embed", "icon": "web", "category": "Web",
        "description": c.url, "developer": "Added by you", "version": "web",
        "system": false, "custom": true, "installed": true, "color": c.color,
        "default_size": [1120, 720],
        "embed": { "url": c.url, "proxy": c.proxy },
    })
}

pub async fn install(State(state): State<SharedState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let app = catalog::find(&id).ok_or_else(|| ApiError::NotFound(format!("unknown app '{id}'")))?;
    state.installed.write().await.insert(app.id.clone());
    state.save_installed().await?;
    state.emit("app-installed", json!({ "id": app.id }));
    Ok(Json(json!({ "id": app.id, "installed": true })))
}

pub async fn uninstall(State(state): State<SharedState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if let Some(app) = catalog::find(&id) {
        if app.system {
            return Err(ApiError::BadRequest(format!("'{}' is a system app and cannot be removed", app.name)));
        }
        state.installed.write().await.remove(&app.id);
        state.save_installed().await?;
    } else {
        // Custom web apps are deleted outright.
        let mut apps = state.custom_apps.write().await;
        let before = apps.len();
        apps.retain(|a| a.id != id);
        if apps.len() == before {
            return Err(ApiError::NotFound(format!("unknown app '{id}'")));
        }
        drop(apps);
        state.save_custom_apps().await?;
    }
    state.emit("app-uninstalled", json!({ "id": id }));
    Ok(Json(json!({ "id": id, "installed": false })))
}

#[derive(Deserialize)]
pub struct NewCustomApp {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub proxy: bool,
}

pub async fn add_custom(State(state): State<SharedState>, Json(req): Json<NewCustomApp>) -> ApiResult<Json<Value>> {
    let name = req.name.trim();
    if name.is_empty() || name.len() > 40 {
        return Err(ApiError::BadRequest("name must be 1–40 characters".into()));
    }
    let url = url::Url::parse(req.url.trim()).map_err(|e| ApiError::BadRequest(format!("invalid URL: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ApiError::BadRequest("only http(s) URLs are supported".into()));
    }
    let color = req.color.filter(|c| c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit()));
    let slug: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let mut apps = state.custom_apps.write().await;
    let mut id = format!("web-{}", slug.trim_matches('-'));
    let mut n = 2;
    while apps.iter().any(|a| a.id == id) || catalog::find(&id).is_some() {
        id = format!("web-{}-{n}", slug.trim_matches('-'));
        n += 1;
    }
    let app = CustomApp { id, name: name.to_string(), url: url.to_string(), color, proxy: req.proxy };
    apps.push(app.clone());
    drop(apps);
    state.save_custom_apps().await?;
    let v = custom_to_catalog(&app);
    state.emit("app-installed", json!({ "id": app.id }));
    Ok(Json(v))
}
