use super::super::{
    AppStorageError, GatewayApplicationError, MessageContent, SessionQueueUpdateRequest, app_error,
    queue_view,
};
use crate::{
    gateway::{MessageContentPart, MessageSendRequest},
    public_text::trim_js_whitespace,
};
use serde_json::Value;

pub(super) fn request_chat_id(
    request: &MessageSendRequest,
) -> Result<String, GatewayApplicationError> {
    match request.chat_id.as_ref() {
        None | Some(Value::Null) => Ok("general".to_owned()),
        Some(Value::String(value)) => {
            let value = trim_js_whitespace(value);
            Ok(if value.is_empty() {
                "general".to_owned()
            } else {
                value.to_owned()
            })
        }
        Some(_) => Err(public_error(
            400,
            "invalid_request",
            "Queued message is invalid.",
        )),
    }
}

pub(super) fn update_content(
    current: &queue_view::MutationRow,
    request: &SessionQueueUpdateRequest,
) -> Result<Option<MessageContent>, GatewayApplicationError> {
    if let Some(content) = request.content_parts.clone() {
        return Ok(Some(content));
    }
    if request.text.is_none() {
        return current
            .content_parts_json
            .as_deref()
            .map(|value| {
                serde_json::from_str(value).map_err(|_| {
                    public_error(
                        400,
                        "invalid_message_content",
                        "Queued message content is invalid.",
                    )
                })
            })
            .transpose();
    }
    Ok(None)
}

pub(super) fn content_text(content: &MessageContent) -> String {
    content
        .parts
        .iter()
        .map(|part| match part {
            MessageContentPart::Text { text, .. } => text.clone(),
            MessageContentPart::SessionRef { title_snapshot, .. }
            | MessageContentPart::ProjectSourceRef { title_snapshot, .. } => {
                format!("@{title_snapshot}")
            }
        })
        .collect()
}

pub(super) fn has_project_sources(content: Option<&MessageContent>) -> bool {
    content.is_some_and(|content| {
        content
            .parts
            .iter()
            .any(|part| matches!(part, MessageContentPart::ProjectSourceRef { .. }))
    })
}

pub(super) fn attachment_values(ids: &[String]) -> Value {
    Value::Array(
        ids.iter()
            .map(|id| serde_json::json!({"file_id": id}))
            .collect(),
    )
}

pub(super) fn attachment_ids(value: &str) -> Result<Vec<String>, GatewayApplicationError> {
    let value = parse_json_value(value)?;
    let Some(items) = value.as_array() else {
        return Err(public_error(
            400,
            "invalid_request",
            "Queued message attachments are invalid.",
        ));
    };
    items
        .iter()
        .map(|item| {
            item.as_str()
                .or_else(|| item.get("file_id").and_then(Value::as_str))
                .map(trim_js_whitespace)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    public_error(
                        400,
                        "invalid_request",
                        "Queued message attachments are invalid.",
                    )
                })
        })
        .collect()
}

pub(super) fn content_matches_current(
    content: &Option<MessageContent>,
    current: &Option<String>,
) -> Result<bool, GatewayApplicationError> {
    let current = current.as_deref().map(parse_json_value).transpose()?;
    let requested = content
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|_| {
            public_error(
                500,
                "app_json_failed",
                "Message content could not be encoded.",
            )
        })?;
    Ok(requested == current)
}

fn parse_json_value(value: &str) -> Result<Value, GatewayApplicationError> {
    serde_json::from_str(value).map_err(|_| {
        public_error(
            500,
            "app_projection_json_invalid",
            "Stored queue data is invalid.",
        )
    })
}

pub(super) fn parse_project_sources(value: Option<&str>) -> Result<Value, GatewayApplicationError> {
    value
        .map(parse_json_value)
        .transpose()
        .map(|value| value.unwrap_or_else(|| Value::Array(Vec::new())))
}

pub(super) fn apply_plan_binding(
    persisted: &mut Value,
    current: &Option<String>,
    requested: Option<&str>,
) {
    let requested = requested
        .map(trim_js_whitespace)
        .filter(|value| !value.is_empty());
    let plan_id = requested
        .map(|value| Value::String(value.to_owned()))
        .or_else(|| {
            current
                .as_deref()
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                .and_then(|value| value.get("plan_id").cloned())
        });
    let Some(plan_id) = plan_id else {
        return;
    };
    if let Some(object) = persisted.as_object_mut() {
        object.insert("plan_id".to_owned(), plan_id);
    }
}

pub(super) fn has_authority(value: &Option<String>) -> bool {
    value
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .is_some_and(|value| {
            value
                .get("authority_request_ref")
                .and_then(Value::as_str)
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
        })
}

pub(super) fn json_string(value: &Value) -> Result<String, GatewayApplicationError> {
    serde_json::to_string(value)
        .map_err(|_| public_error(500, "app_json_failed", "Queue data could not be encoded."))
}

pub(super) fn json_string_storage(value: &Value) -> Result<String, AppStorageError> {
    serde_json::to_string(value)
        .map_err(|_| AppStorageError::new("app_json_failed", "Queue data could not be encoded."))
}

pub(super) fn invalid_resolution_storage() -> AppStorageError {
    AppStorageError::new(
        "turn_control_resolution_invalid",
        "Turn controls are unavailable.",
    )
}

pub(super) fn storage_not_found() -> AppStorageError {
    AppStorageError::new("queued_message_not_found", "Queued message not found.")
}

pub(super) fn not_found_error() -> GatewayApplicationError {
    app_error(storage_not_found())
}

pub(super) fn identity_conflict() -> GatewayApplicationError {
    public_error(
        409,
        "queued_message_identity_conflict",
        "This client message id was already accepted with different input.",
    )
}

pub(super) fn authority_immutable() -> GatewayApplicationError {
    public_error(
        409,
        "authority_queue_immutable",
        "Approved command queue entries cannot be edited.",
    )
}

pub(super) fn public_error(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.to_owned(),
        message: message.to_owned(),
    }
}
