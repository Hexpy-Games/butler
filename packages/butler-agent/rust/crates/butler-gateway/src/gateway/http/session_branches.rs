//! Topic branch creation through the App session owner: tool-originated
//! (`/internal/session-branches`) and App-originated (`/space/branches`),
//! plus the way back to a branch's source answer (`/space/branch-source`).

use std::{collections::HashMap, sync::Arc};

use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use serde_json::{Value, json};

use super::{
    HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json as response_json, read_body_with_limit,
};
use crate::gateway::application::{AppSessionBranchDestination, AppSessionBranchRequest};
use crate::gateway::{
    AppSessionViewPage, AppStartTopicConversationRequest, SendMessageCommand,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

/// The `/session-view` default page size.
const SOURCE_PAGE_LIMIT: usize = 200;

pub(super) async fn post(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let input: AppStartTopicConversationRequest =
        serde_json::from_slice(&bytes).map_err(|_| invalid_request())?;
    let request_id = input.request_id.clone();
    let follow_up = input
        .follow_up
        .as_ref()
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned);
    let started = follow_up.is_some();
    let branch = state
        .application
        .start_topic_conversation(input, state.shutdown.clone())
        .await?;
    if let Some(text) = follow_up {
        state
            .application
            .send_message(SendMessageCommand {
                chat_id: branch.session.id.clone(),
                request: crate::gateway::MessageSendRequest {
                    expected_project_id: None,
                    content_parts: None,
                    chat_id: None,
                    text: Some(Value::String(text)),
                    client_message_id: Some(Value::String(format!("branch-followup-{request_id}"))),
                    attachments: None,
                    model: None,
                    reasoning_effort: None,
                    access_mode: None,
                    plan_mode: None,
                    subsession_result: None,
                    schedule_run: None,
                },
            })
            .await?;
    }
    let data = json!({
        "session_id": branch.session.id,
        "title": branch.session.title,
        "project_id": branch.session.project_id,
        "context": branch.seed.summary,
        "source_session_id": branch.seed.source_session_id,
        "source_message_id": branch.seed.source_message_id,
        "started": started,
    });
    response_json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

/// The App's `/space/` branch routes.
pub(super) async fn post_space(
    state: Arc<HttpState>,
    request: Request<Body>,
    path: &str,
) -> Result<Option<Response>, HttpError> {
    match path {
        "/space/branches" => post_app(state, request).await.map(Some),
        "/space/branch-source" => post_source(state, request).await.map(Some),
        _ => Ok(None),
    }
}

/// `POST /space/branches`: the App's "new conversation / new project from this
/// answer" request (`SessionBranchRequest`). Any App session with a completed
/// answer is a valid source, project sessions included.
async fn post_app(state: Arc<HttpState>, request: Request<Body>) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let body: AppSessionBranchRequest =
        serde_json::from_slice(&bytes).map_err(|_| invalid_request())?;
    let input = app_branch_request(body).ok_or_else(invalid_request)?;
    let branch = state
        .application
        .start_topic_conversation(input, state.shutdown.clone())
        .await?;
    response_json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: json!({ "session": branch.session, "seed": branch.seed }),
        },
    )
}

/// `POST /space/branch-source`: the App's "go to the source answer" request
/// from a branch conversation. Answers the source session's message page that
/// ends at that answer, with the same window cursors as `/session-view`.
async fn post_source(state: Arc<HttpState>, request: Request<Body>) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let session_id = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|body| body.get("sessionId")?.as_str().map(str::to_owned))
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| HttpError::public(400, "session_required", "Session id is required."))?;
    let source = state.application.branch_source(session_id).await?;
    let page = AppSessionViewPage {
        after_cursor: None,
        before_cursor: Some(source.cursor.saturating_add(1)),
        limit: SOURCE_PAGE_LIMIT,
    };
    let view = state
        .application
        .session_view(source.session_id.clone(), page.clone())
        .await?;
    let mut view = super::subsessions::decorate_window(
        view,
        &source.session_id,
        &page,
        &HashMap::new(),
        &state.session_cursor_secret,
    )?;
    let shown = view["messages"].as_array().is_some_and(|messages| {
        messages
            .iter()
            .any(|m| m["id"] == source.message_id.as_str())
    });
    if !shown {
        return Err(HttpError::public(
            404,
            "branch_origin_unavailable",
            "원본 답변을 찾을 수 없습니다.",
        ));
    }
    if let Some(artifacts) = view.get_mut("artifacts").and_then(Value::as_array_mut) {
        artifacts.extend(state.previews.artifacts(&source.session_id));
    }
    response_json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: json!({ "view": view, "messageId": source.message_id }),
        },
    )
}

/// The App request as the branch owner's input. The App never starts work in
/// the new conversation, so a `followUp` is refused rather than ignored.
fn app_branch_request(body: AppSessionBranchRequest) -> Option<AppStartTopicConversationRequest> {
    let present = |value: &str| !value.trim().is_empty();
    if body.follow_up.is_some()
        || !present(&body.source_session_id)
        || !present(&body.source_message_id)
    {
        return None;
    }
    let (destination, project_id, project_name) = match body.destination {
        AppSessionBranchDestination::Chat => ("chat", None, None),
        AppSessionBranchDestination::Project { project_id } => {
            ("project", Some(project_id).filter(|id| present(id)), None)
        }
        AppSessionBranchDestination::NewProject { name } => {
            ("new_project", None, Some(name).filter(|name| present(name)))
        }
    };
    if destination == "project" && project_id.is_none() {
        return None;
    }
    Some(AppStartTopicConversationRequest {
        request_id: body.request_id,
        current_session_id: None,
        source_session_id: Some(body.source_session_id),
        source_message_id: Some(body.source_message_id),
        title: body.title,
        destination: destination.to_owned(),
        project_id,
        project_name,
        follow_up: None,
    })
}

fn invalid_request() -> HttpError {
    HttpError::public(
        400,
        "branch_request_invalid",
        "대화 생성 요청을 확인해 주세요.",
    )
}
