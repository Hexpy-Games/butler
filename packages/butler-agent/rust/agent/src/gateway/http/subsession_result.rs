//! Authenticated BTCC Steward result admission through the canonical App queue.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use serde_json::Value;

use super::{HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json, read_body_with_limit};
use crate::gateway::{
    SendMessageCommand,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

pub(super) async fn post(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let object = value.as_object().ok_or_else(invalid_request)?;
    let required = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(invalid_request)
    };
    let relation_id = required("relation_id")?;
    let result_id = required("result_id")?;
    let safe_title = required("safe_title")?;
    let chat_id = required("parent_chat_id")?;
    let text = required("text")?;
    let model = required("model_ref")?;
    let reasoning = required("reasoning_effort")?;
    let access = required("access_mode")?;
    if !matches!(access.as_str(), "full_access" | "ask_first" | "read_only") {
        return Err(invalid_request());
    }
    let client = format!(
        "subsession-result:{}",
        crate::btcc::digest_identity(&format!("{relation_id}\0{result_id}"))
    );
    let result = state
        .application
        .send_message(SendMessageCommand {
            chat_id,
            request: crate::gateway::MessageSendRequest {
                expected_project_id: None,
                content_parts: None,
                chat_id: None,
                text: Some(text.into()),
                client_message_id: Some(client.into()),
                attachments: None,
                model: Some(model.into()),
                reasoning_effort: Some(reasoning.into()),
                access_mode: Some(access.into()),
                plan_mode: None,
                subsession_result: Some(crate::btcc::SubsessionResultContext {
                    relation_id,
                    result_id,
                    safe_title,
                }),
            },
        })
        .await?;
    json(
        StatusCode::ACCEPTED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: result,
        },
    )
}

fn invalid_request() -> HttpError {
    HttpError::public(400, "invalid_request", "Invalid internal Steward result.")
}
