use axum::{extract::State, Json};
use serde_json::Value;

use crate::{
    error::{ApiError, ApiResult},
    state::{default_prefs, SharedState},
};

pub async fn get_prefs(State(state): State<SharedState>) -> Json<Value> {
    Json(state.prefs.read().await.clone())
}

/// Replace the whole preference document.
pub async fn put_prefs(State(state): State<SharedState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    if !body.is_object() {
        return Err(ApiError::BadRequest("prefs must be a JSON object".into()));
    }
    *state.prefs.write().await = body.clone();
    state.save_prefs().await?;
    state.emit("prefs", body.clone());
    Ok(Json(body))
}

/// RFC 7396 JSON merge-patch.
pub async fn patch_prefs(State(state): State<SharedState>, Json(patch): Json<Value>) -> ApiResult<Json<Value>> {
    let merged = {
        let mut prefs = state.prefs.write().await;
        merge(&mut prefs, &patch);
        prefs.clone()
    };
    state.save_prefs().await?;
    state.emit("prefs", merged.clone());
    Ok(Json(merged))
}

pub async fn reset_prefs(State(state): State<SharedState>) -> ApiResult<Json<Value>> {
    let fresh = default_prefs();
    *state.prefs.write().await = fresh.clone();
    state.save_prefs().await?;
    state.emit("prefs", fresh.clone());
    Ok(Json(fresh))
}

fn merge(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(t), Value::Object(p)) => {
            for (k, v) in p {
                if v.is_null() {
                    t.remove(k);
                } else {
                    merge(t.entry(k.clone()).or_insert(Value::Null), v);
                }
            }
        }
        (t, p) => *t = p.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::merge;
    use serde_json::json;

    #[test]
    fn merge_patch_semantics() {
        let mut doc = json!({ "a": 1, "b": { "c": 2, "d": 3 }, "e": [1, 2] });
        merge(&mut doc, &json!({ "b": { "c": 9, "d": null }, "e": [3], "f": "new" }));
        assert_eq!(doc, json!({ "a": 1, "b": { "c": 9 }, "e": [3], "f": "new" }));
    }
}
