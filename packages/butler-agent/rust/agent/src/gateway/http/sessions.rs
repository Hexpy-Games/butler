//! Source App session create/list routes.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode, Uri},
    response::Response,
};
use serde_json::Value;

use super::{HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json, query, read_body_with_limit};
use crate::gateway::{
    AppChatKind, AppCreateSessionInput, AppCreateSessionRequest, AppWorkspaceMode,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

pub(super) async fn chats(state: Arc<HttpState>) -> Result<Response, HttpError> {
    let chats = state.application.list_chats().await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: chats,
        },
    )
}

pub(super) async fn list(state: Arc<HttpState>, uri: &Uri) -> Result<Response, HttpError> {
    let params = query(uri);
    let kind = params
        .get("kind")
        .filter(|kind| matches!(kind.as_str(), "chat" | "project"))
        .cloned();
    let project_id = params.get("project_id").cloned();
    let sessions = state.application.list_sessions(kind, project_id).await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: serde_json::json!({"sessions":sessions}),
        },
    )
}

pub(super) async fn project_list(state: Arc<HttpState>, uri: &Uri) -> Result<Response, HttpError> {
    let project_id = query(uri).get("project_id").cloned();
    let sessions = state
        .application
        .list_sessions(Some("project".into()), project_id.clone())
        .await?;
    let mut data = serde_json::json!({"sessions": sessions});
    if let Some(project_id) = project_id {
        data["project_id"] = project_id.into();
    }
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

pub(super) async fn create(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let request = parse_request(value).ok_or_else(|| {
        HttpError::public(
            400,
            "invalid_request",
            "A valid session kind and workspace mode are required.",
        )
    })?;
    let created = state
        .application
        .create_session(request, state.shutdown.clone())
        .await?;
    json(
        StatusCode::CREATED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: created,
        },
    )
}

fn parse_request(value: Value) -> Option<AppCreateSessionRequest> {
    let object = value.as_object()?;
    let kind = match object.get("kind")?.as_str()? {
        "chat" => AppChatKind::Chat,
        "project" => AppChatKind::Project,
        _ => return None,
    };
    let workspace_mode = match object.get("workspace_mode") {
        None => AppWorkspaceMode::Local,
        Some(Value::String(mode)) if mode == "local" => AppWorkspaceMode::Local,
        Some(Value::String(mode)) if mode == "worktree" && kind == AppChatKind::Project => {
            AppWorkspaceMode::Worktree
        }
        _ => return None,
    };
    for field in [
        "title",
        "initial_message",
        "project_id",
        "session_hint",
        "idempotency_key",
    ] {
        if object.get(field).is_some_and(|value| !value.is_string()) {
            return None;
        }
    }
    let string = |key| object.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(AppCreateSessionRequest {
        input: AppCreateSessionInput {
            kind,
            title: string("title"),
            project_id: string("project_id"),
            session_hint: string("session_hint"),
        },
        workspace_mode,
    })
}
