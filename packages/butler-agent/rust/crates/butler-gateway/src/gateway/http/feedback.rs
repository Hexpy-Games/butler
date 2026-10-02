//! Authenticated owner-only Recent feedback control.
use super::{HttpError, HttpState, json, read_body_with_limit};
use crate::gateway::{
    AppFeedbackCommand,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};
use axum::{
    body::Body,
    http::{Method, StatusCode, Uri},
    response::Response,
};
use std::sync::Arc;

pub(super) async fn route(
    state: Arc<HttpState>,
    request: axum::http::Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let command = match (request.method(), uri.path()) {
        (&Method::POST, "/memory/feedback/consolidate") => {
            let bytes = read_body_with_limit(request.into_body(), 4096).await?;
            let input = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
            AppFeedbackCommand::Consolidate { input }
        }
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    let data = state
        .application
        .feedback(command, state.shutdown.child_token())
        .await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}
