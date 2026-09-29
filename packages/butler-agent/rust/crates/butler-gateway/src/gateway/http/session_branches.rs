//! Topic branch creation through the App session owner: tool-originated
//! (`/internal/session-branches`) and App-originated (`/space/branches`).

use std::sync::Arc;

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
    AppStartTopicConversationRequest, SendMessageCommand,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

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

/// `POST /space/branches`: the App's "new conversation / new project from this
/// answer" request (`SessionBranchRequest`). Any App session with a completed
/// answer is a valid source, project sessions included.
pub(super) async fn post_app(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
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
