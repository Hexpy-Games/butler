use std::sync::Arc;

use axum::{body::Body, http::StatusCode, response::Response};
use serde_json::Value;

use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};

use super::{HttpError, HttpState, json, read_body_with_limit};

pub(super) async fn get(state: Arc<HttpState>) -> Result<Response, HttpError> {
    let settings = state.application.read_settings().await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: settings,
        },
    )
}

pub(super) async fn patch(
    state: Arc<HttpState>,
    request: axum::http::Request<Body>,
) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 1024 * 1024).await?;
    let input: Value = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let settings = state.application.update_settings(input).await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: settings,
        },
    )
}
