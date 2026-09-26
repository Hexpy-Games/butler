//! Source App space mutation routes.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode, Uri},
    response::Response,
};
use serde_json::{Map, Value};

use super::{HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json, read_body_with_limit};
use crate::gateway::{
    AppRelocateSessionRequest, AppSpaceCommand, AppSpaceOrigin,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Option<Response>, HttpError> {
    let path = uri.path();
    let method = request.method().clone();
    if method == Method::POST && path == "/space/relocations" {
        let value = parse_body(request).await?;
        let relocation = relocation_request(&value)?;
        let result = state.application.relocate_session(relocation).await?;
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: result,
            },
        )
        .map(Some);
    }
    let group = path
        .strip_prefix("/space/groups/")
        .filter(|value| !value.is_empty() && !value.contains('/'));
    let action = if method == Method::POST {
        match path {
            "/space/groups" => Some("create"),
            "/space/moves" => Some("move"),
            "/space/group-sessions" => Some("group"),
            "/space/undo" => Some("undo"),
            "/space/pins" => Some("pin"),
            _ => None,
        }
    } else if group.is_some() && method == Method::PATCH {
        Some("rename")
    } else if group.is_some() && method == Method::DELETE {
        Some("dissolve")
    } else {
        None
    };
    let Some(action) = action else {
        return Ok(None);
    };
    let mut value = parse_body(request).await?;
    let mut object = value.as_object().cloned().ok_or_else(invalid_command)?;
    object.insert("action".into(), Value::String(action.to_owned()));
    if let Some(group) = group {
        object.insert(
            "groupId".into(),
            Value::String(super::subsessions::decode_component(group)?),
        );
    }
    value = Value::Object(object.clone());
    if !valid_space_command(&object) {
        return Err(invalid_command());
    }
    let command =
        serde_json::from_value::<AppSpaceCommand>(value).map_err(|_| invalid_command())?;
    let title = matches!(action, "group").then(|| "새 그룹".to_owned());
    let result = state
        .application
        .mutate_space(command, AppSpaceOrigin::Manual, title)
        .await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: result,
        },
    )
    .map(Some)
}

fn valid_space_command(value: &Map<String, Value>) -> bool {
    let expected = value
        .get("expectedRevision")
        .and_then(Value::as_i64)
        .is_some_and(|revision| (0..=9_007_199_254_740_991).contains(&revision));
    if !expected {
        return false;
    }
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
    };
    let key_or_root = |key: &str| {
        value
            .get(key)
            .is_some_and(|value| value.is_null() || text(key))
    };
    match value.get("action").and_then(Value::as_str) {
        Some("create") => text("title") && key_or_root("parentKey"),
        Some("rename") => text("groupId") && text("title"),
        Some("dissolve") => text("groupId"),
        Some("move") => {
            text("sourceKey")
                && key_or_root("targetKey")
                && matches!(
                    value.get("position").and_then(Value::as_str),
                    Some("before" | "after" | "inside")
                )
        }
        Some("group") => {
            text("sourceKey")
                && text("targetKey")
                && (value.get("title").is_none() || text("title"))
        }
        Some("undo") => text("undoToken"),
        Some("pin") => text("nodeKey") && value.get("pinned").is_some_and(Value::is_boolean),
        _ => false,
    }
}

async fn parse_body(request: Request<Body>) -> Result<Value, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())
}

fn invalid_command() -> HttpError {
    HttpError::public(
        400,
        "invalid_space_command",
        "정리할 항목과 최신 목록 버전이 필요합니다.",
    )
}

fn relocation_request(value: &Value) -> Result<AppRelocateSessionRequest, HttpError> {
    let Some(object) = value.as_object() else {
        return Err(invalid_relocation());
    };
    let operation_id = object
        .get("operationId")
        .and_then(Value::as_str)
        .filter(|value| {
            (1..=80).contains(&value.len())
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
        .ok_or_else(invalid_relocation)?
        .to_owned();
    let session_id = object
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(invalid_relocation)?
        .to_owned();
    let expected_revision = object
        .get("expectedRevision")
        .and_then(Value::as_f64)
        .filter(|value| {
            value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
        })
        .map(crate::json::saturating_i64)
        .ok_or_else(invalid_relocation)?;
    let target_key = match object.get("targetKey") {
        Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        _ => return Err(invalid_relocation()),
    };
    let position = serde_json::from_value(
        object
            .get("position")
            .cloned()
            .ok_or_else(invalid_relocation)?,
    )
    .map_err(|_| invalid_relocation())?;
    Ok(AppRelocateSessionRequest {
        operation_id,
        session_id,
        expected_revision,
        target_key,
        position,
    })
}

fn invalid_relocation() -> HttpError {
    HttpError::public(
        400,
        "invalid_relocation",
        "옮길 대화와 이동 위치가 필요합니다.",
    )
}
