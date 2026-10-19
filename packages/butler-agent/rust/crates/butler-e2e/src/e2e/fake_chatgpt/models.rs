use super::State as Authority;
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::{collections::BTreeMap, sync::Arc};
pub(super) async fn list(State(state): State<Arc<Authority>>, headers: HeaderMap) -> Response {
    state.record("models", &BTreeMap::new());
    let mut faults = state
        .faults
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if faults.models_401 > 0 {
        faults.models_401 -= 1;
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if faults.models_503 > 0 {
        faults.models_503 -= 1;
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    drop(faults);
    if !headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.starts_with("Bearer "))
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(serde_json::json!({"models":state.models.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()})).into_response()
}

pub(super) fn defaults() -> Vec<serde_json::Value> {
    let catalog: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../butler-models/src/models/catalog/static-catalog.json"
    ))
    .unwrap_or_default();
    catalog["models"].as_array().into_iter().flatten().filter(|m| m["provider_id"] == "openai")
        .map(|m| serde_json::json!({"slug":m["model_id"], "display_name":m["display_name"], "visibility":"list"})).collect()
}
