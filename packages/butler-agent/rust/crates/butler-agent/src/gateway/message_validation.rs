use serde_json::{Map, Value};

use super::protocol::{MessageContent, MessageContentPart, MessageSendRequest};

pub(super) enum MessageRequestError {
    Invalid,
    AuthorityProperty,
    SubsessionProperty,
}

pub(super) fn validate_message_request(
    value: &Value,
) -> Result<MessageSendRequest, MessageRequestError> {
    let object = value.as_object().ok_or(MessageRequestError::Invalid)?;
    let expected_project_id = expected_project_id(object)?;
    let content_parts = match object.get("content_parts") {
        Some(value) => Some(validate_content(value)?),
        None => None,
    };
    let derived_text = content_parts.as_ref().map(message_content_text);
    let request_text = object.get("text");
    let has_text = derived_text.as_ref().map_or_else(
        || {
            request_text
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
        },
        |text| !text.trim().is_empty(),
    );
    let text_is_string = derived_text.is_some() || request_text.is_some_and(Value::is_string);
    let has_attachments = valid_attachments(object.get("attachments"));
    if !has_attachments && (!text_is_string || !has_text) {
        return Err(MessageRequestError::Invalid);
    }
    if object.contains_key("authority_request_ref") {
        return Err(MessageRequestError::AuthorityProperty);
    }
    if object.contains_key("subsession_result") {
        return Err(MessageRequestError::SubsessionProperty);
    }

    Ok(MessageSendRequest {
        expected_project_id,
        content_parts,
        chat_id: object.get("chat_id").cloned(),
        text: object.get("text").cloned(),
        client_message_id: object.get("client_message_id").cloned(),
        attachments: object.get("attachments").cloned(),
        model: object.get("model").cloned(),
        reasoning_effort: object.get("reasoning_effort").cloned(),
        access_mode: object.get("access_mode").cloned(),
        plan_mode: object.get("plan_mode").cloned(),
        subsession_result: None,
    })
}

fn expected_project_id(object: &Map<String, Value>) -> Result<Option<String>, MessageRequestError> {
    let Some(value) = object.get("expected_project_id") else {
        return Ok(None);
    };
    let text = value.as_str().ok_or(MessageRequestError::Invalid)?;
    if text.is_empty() || utf16_len(text) > 256 {
        return Err(MessageRequestError::Invalid);
    }
    Ok(Some(text.to_owned()))
}

fn validate_content(value: &Value) -> Result<MessageContent, MessageRequestError> {
    let object = value.as_object().ok_or(MessageRequestError::Invalid)?;
    if object.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Err(MessageRequestError::Invalid);
    }
    let parts = object
        .get("parts")
        .and_then(Value::as_array)
        .ok_or(MessageRequestError::Invalid)?;
    if parts.len() > 1_000 || !parts.iter().all(valid_content_part) {
        return Err(MessageRequestError::Invalid);
    }
    let mut normalized = value.clone();
    crate::json::object_mut(&mut normalized).insert("version".to_owned(), Value::from(1));
    serde_json::from_value(normalized).map_err(|_| MessageRequestError::Invalid)
}

fn valid_content_part(value: &Value) -> bool {
    let Some(part) = value.as_object() else {
        return false;
    };
    match part.get("type").and_then(Value::as_str) {
        Some("text") => part.get("text").is_some_and(Value::is_string),
        Some("session_ref") => {
            part.get("sessionId")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.trim().is_empty())
                && part.get("titleSnapshot").is_some_and(Value::is_string)
        }
        Some("project_source_ref") => valid_project_source(part),
        _ => false,
    }
}

fn valid_project_source(part: &Map<String, Value>) -> bool {
    let valid_text = |key: &str, max: usize| {
        part.get(key)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty() && utf16_len(text) <= max)
    };
    let topic_valid = part.get("topic").is_none_or(|topic| {
        topic
            .as_str()
            .is_some_and(|text| !text.trim().is_empty() && utf16_len(text) <= 80)
    });
    let Some(source) = part.get("source").and_then(Value::as_object) else {
        return false;
    };
    let kind_valid = source
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| {
            matches!(
                kind,
                "work" | "task" | "plan" | "spec" | "report" | "message" | "reference"
            )
        });
    let id_valid = source
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty() && utf16_len(id) <= 256);
    let revision_valid = source
        .get("revision")
        .and_then(Value::as_str)
        .is_some_and(|revision| {
            revision.len() == 64
                && revision
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
    valid_text("projectId", 256)
        && part
            .get("titleSnapshot")
            .and_then(Value::as_str)
            .is_some_and(|text| utf16_len(text) <= 500)
        && topic_valid
        && kind_valid
        && id_valid
        && revision_valid
}

fn valid_attachments(value: Option<&Value>) -> bool {
    value.and_then(Value::as_array).is_some_and(|attachments| {
        !attachments.is_empty()
            && attachments.iter().all(|attachment| {
                attachment
                    .as_object()
                    .and_then(|item| item.get("file_id"))
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.trim().is_empty())
            })
    })
}

fn message_content_text(content: &MessageContent) -> String {
    content
        .parts
        .iter()
        .map(|part| match part {
            MessageContentPart::Text { text, .. } => text.as_str(),
            MessageContentPart::SessionRef { title_snapshot, .. }
            | MessageContentPart::ProjectSourceRef { title_snapshot, .. } => {
                title_snapshot.as_str()
            }
        })
        .enumerate()
        .fold(String::new(), |mut output, (index, text)| {
            if !matches!(content.parts[index], MessageContentPart::Text { .. }) {
                output.push('@');
            }
            output.push_str(text);
            output
        })
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}
