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
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Enabled {
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Edit {
    text: String,
}

pub(super) async fn route(
    state: Arc<HttpState>,
    request: axum::http::Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let command = command(request, uri).await?;
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

async fn command(
    request: axum::http::Request<Body>,
    uri: &Uri,
) -> Result<AppFeedbackCommand, HttpError> {
    match (request.method(), uri.path()) {
        (&Method::GET, "/memory/feedback") => Ok(AppFeedbackCommand::List),
        (&Method::PATCH, "/memory/feedback") => {
            let input: Enabled = body(request).await?;
            Ok(AppFeedbackCommand::SetEnabled {
                enabled: input.enabled,
            })
        }
        (&Method::POST, "/memory/feedback/reset") => Ok(AppFeedbackCommand::Reset),
        (&Method::POST, "/memory/feedback/consolidate") => Ok(AppFeedbackCommand::Consolidate {
            input: body(request).await?,
        }),
        (&Method::PATCH, path) if entry_id(path).is_some() => {
            let id = entry_id(path).unwrap_or_default().to_owned();
            let input: Edit = body(request).await?;
            Ok(AppFeedbackCommand::Edit {
                id,
                text: input.text,
            })
        }
        (&Method::DELETE, path) if entry_id(path).is_some() => Ok(AppFeedbackCommand::Delete {
            id: entry_id(path).unwrap_or_default().to_owned(),
        }),
        _ => Err(HttpError::public(404, "not_found", "Route not found.")),
    }
}
fn entry_id(path: &str) -> Option<&str> {
    path.strip_prefix("/memory/feedback/")
        .filter(|id| id.starts_with("fb_") && !id.contains('/'))
}
async fn body<T: serde::de::DeserializeOwned>(
    request: axum::http::Request<Body>,
) -> Result<T, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 1024 * 1024).await?;
    serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())
}
