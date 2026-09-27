//! Tool-originated topic branch creation through the App session owner.

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

fn invalid_request() -> HttpError {
    HttpError::public(
        400,
        "branch_request_invalid",
        "대화 생성 요청을 확인해 주세요.",
    )
}
