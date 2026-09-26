//! Source App project list/create public routes.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode, Uri},
    response::Response,
};
use serde_json::Value;

use super::{HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json, query, read_body_with_limit};
use crate::gateway::{
    AppCreateProjectRequest, AppProjectSource,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

pub(super) async fn list(state: Arc<HttpState>, uri: &Uri) -> Result<Response, HttpError> {
    let include_sessions = query(uri)
        .get("include_sessions")
        .is_some_and(|value| value == "true");
    let projects = state.application.list_projects(include_sessions).await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: projects,
        },
    )
}

pub(super) async fn create(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let request = parse_request(value)
        .ok_or_else(|| HttpError::public(400, "invalid_request", "Project source is required."))?;
    let created = state.application.create_project(request).await?;
    json(
        StatusCode::CREATED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: created,
        },
    )
}

fn parse_request(value: Value) -> Option<AppCreateProjectRequest> {
    let object = value.as_object()?;
    let source = match object.get("source")?.as_str()? {
        "scratch" => AppProjectSource::Scratch,
        "existing_folder" => AppProjectSource::ExistingFolder,
        _ => return None,
    };
    for key in ["display_name", "folder_selection_token", "idempotency_key"] {
        if object.get(key).is_some_and(|value| !value.is_string()) {
            return None;
        }
    }
    let display_name = object
        .get("display_name")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if source == AppProjectSource::Scratch
        && display_name
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return None;
    }
    Some(AppCreateProjectRequest {
        source,
        display_name,
        folder_selection_token: object
            .get("folder_selection_token")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}
