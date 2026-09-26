//! Project and session lifecycle HTTP adapters over the durable App owner.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode, Uri},
    response::Response,
};
use serde_json::Value;

use super::{HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json, query, read_body_with_limit};
use crate::gateway::{
    AppProjectUpdate, AppSessionUpdate,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Option<Response>, HttpError> {
    let method = request.method().clone();
    let path = uri.path();
    if method == Method::PATCH
        && let Some(encoded) = resource_id(path, "/projects/")
    {
        let value = parse_body(request).await?;
        let input = project_patch(&value)?;
        let id = super::subsessions::decode_component(encoded)?;
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: state.application.update_project(id, input).await?,
            },
        )
        .map(Some);
    }
    if method == Method::POST
        && let Some(encoded) = action_id(path, "/projects/", "/archive")
    {
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: state
                    .application
                    .archive_project(super::subsessions::decode_component(encoded)?)
                    .await?,
            },
        )
        .map(Some);
    }
    if method == Method::POST
        && let Some(encoded) = action_id(path, "/projects/", "/pin")
    {
        let value = parse_body(request).await?;
        let pinned = value
            .as_object()
            .and_then(|object| object.get("pinned"))
            .and_then(Value::as_bool);
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: state
                    .application
                    .pin_project(super::subsessions::decode_component(encoded)?, pinned)
                    .await?,
            },
        )
        .map(Some);
    }
    if method == Method::DELETE
        && let Some(encoded) = resource_id(path, "/projects/")
    {
        let permanent = query(uri)
            .get("permanent")
            .is_some_and(|value| value == "true");
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: state
                    .application
                    .delete_project(super::subsessions::decode_component(encoded)?, permanent)
                    .await?,
            },
        )
        .map(Some);
    }
    if method == Method::PATCH
        && let Some(encoded) = resource_id(path, "/sessions/")
    {
        let value = parse_body(request).await?;
        let input = session_patch(&value).ok_or_else(|| {
            HttpError::public(
                400,
                "invalid_session_update",
                "Session update contains unsupported fields.",
            )
        })?;
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: state
                    .application
                    .update_session(super::subsessions::decode_component(encoded)?, input)
                    .await?,
            },
        )
        .map(Some);
    }
    if method == Method::POST
        && let Some(encoded) = action_id(path, "/sessions/", "/archive")
    {
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: state
                    .application
                    .archive_session(super::subsessions::decode_component(encoded)?, None)
                    .await?,
            },
        )
        .map(Some);
    }
    if method == Method::DELETE
        && let Some(encoded) = resource_id(path, "/sessions/")
    {
        let permanent = query(uri)
            .get("permanent")
            .is_some_and(|value| value == "true");
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: state
                    .application
                    .delete_session(super::subsessions::decode_component(encoded)?, permanent)
                    .await?,
            },
        )
        .map(Some);
    }
    Ok(None)
}

fn project_patch(value: &Value) -> Result<AppProjectUpdate, HttpError> {
    let Some(object) = value.as_object() else {
        return Ok(AppProjectUpdate::default());
    };
    if object
        .get("archived")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(HttpError::public(
            400,
            "invalid_request",
            "Project update contains unsupported fields.",
        ));
    }
    Ok(AppProjectUpdate {
        display_name: object
            .get("display_name")
            .and_then(Value::as_str)
            .map(str::to_owned),
        pinned: object.get("pinned").and_then(Value::as_bool),
        archived: object.get("archived").and_then(Value::as_bool),
    })
}

fn session_patch(value: &Value) -> Option<AppSessionUpdate> {
    let object = value.as_object()?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "title" | "archived"))
        || object.get("title").is_some_and(|value| !value.is_string())
        || object
            .get("archived")
            .is_some_and(|value| !value.is_boolean())
    {
        return None;
    }
    Some(AppSessionUpdate {
        title: object
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_owned),
        archived: object.get("archived").and_then(Value::as_bool),
    })
}

async fn parse_body(request: Request<Body>) -> Result<Value, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())
}

fn resource_id<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    path.strip_prefix(prefix)
        .filter(|value| !value.is_empty() && !value.contains('/'))
}

fn action_id<'a>(path: &'a str, prefix: &str, suffix: &str) -> Option<&'a str> {
    path.strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(suffix))
        .filter(|value| !value.is_empty() && !value.contains('/'))
}
