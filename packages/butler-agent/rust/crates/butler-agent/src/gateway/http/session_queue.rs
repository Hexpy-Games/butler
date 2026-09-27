use axum::{
    body::Body,
    http::{Method, Request, Uri},
    response::Response,
};
use serde_json::{Map, Value};

use super::{HttpError, HttpState, json, read_body_with_limit};
use crate::gateway::{
    MessageContent, MessageContentPart, MessageSendRequest, SessionQueueUpdateRequest,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

pub(super) async fn create(
    state: std::sync::Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let body = read_body_with_limit(request.into_body(), super::MAX_REQUEST_BODY_SIZE).await?;
    let value: Value = serde_json::from_slice(&body).map_err(|_| HttpError::invalid_json())?;
    let request = strict_create(&value)?;
    let queue = state.application.create_session_queue(request).await?;
    json(
        axum::http::StatusCode::ACCEPTED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: queue,
        },
    )
}

pub(super) async fn route(
    state: std::sync::Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let id = uri
        .path()
        .strip_prefix("/session-queue/")
        .filter(|value| !value.is_empty() && !value.contains('/'))
        .ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
    let id = decode_component(id)?;
    match *request.method() {
        Method::PATCH => {
            let body =
                read_body_with_limit(request.into_body(), super::MAX_REQUEST_BODY_SIZE).await?;
            let value: Value =
                serde_json::from_slice(&body).map_err(|_| HttpError::invalid_json())?;
            let update = parse_update(&value)?;
            let queue = state.application.update_session_queue(id, update).await?;
            json(
                axum::http::StatusCode::OK,
                ApiEnvelope {
                    protocol_version: APP_PROTOCOL_VERSION,
                    data: queue,
                },
            )
        }
        Method::DELETE => {
            let queue = state.application.delete_session_queue(id).await?;
            json(
                axum::http::StatusCode::OK,
                ApiEnvelope {
                    protocol_version: APP_PROTOCOL_VERSION,
                    data: queue,
                },
            )
        }
        _ => Err(HttpError::public(404, "not_found", "Route not found.")),
    }
}

fn strict_create(value: &Value) -> Result<MessageSendRequest, HttpError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid_request("Queued message text is required."))?;
    let text = optional_string_value(object, "text", "Queued message request is invalid.")?;
    let content_parts = object.get("content_parts").map(parse_content).transpose()?;
    let attachments = strict_attachments(object.get("attachments"))?;
    let has_text = content_parts
        .as_ref()
        .map(content_text)
        .or_else(|| text.as_ref().and_then(Value::as_str).map(str::to_owned))
        .is_some_and(|value| !value.trim().is_empty());
    let has_attachments = attachments.as_ref().is_some_and(|items| !items.is_empty());
    let text_is_string = content_parts.is_some() || text.is_some();
    if !(has_attachments || (text_is_string && has_text)) {
        return Err(invalid_request("Queued message text is required."));
    }
    Ok(MessageSendRequest {
        subsession_result: None,
        expected_project_id: None,
        content_parts,
        chat_id: optional_string_value(object, "chat_id", "Queued message request is invalid.")?,
        text,
        client_message_id: optional_string_value(
            object,
            "client_message_id",
            "Queued message request is invalid.",
        )?,
        attachments: attachments.map(Value::Array),
        model: optional_string_value(object, "model", "Queued message request is invalid.")?,
        reasoning_effort: optional_string_value(
            object,
            "reasoning_effort",
            "Queued message request is invalid.",
        )?,
        access_mode: optional_string_value(
            object,
            "access_mode",
            "Queued message request is invalid.",
        )?,
        plan_mode: optional_bool_value(object, "plan_mode", "Queued message request is invalid.")?,
    })
}

fn parse_update(value: &Value) -> Result<SessionQueueUpdateRequest, HttpError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid_request("Queued message update is invalid."))?;
    let text = optional_string(object, "text")?;
    let content_parts = object.get("content_parts").map(parse_content).transpose()?;
    let attachments = match object.get("attachments") {
        None => None,
        Some(value) => Some(
            strict_attachments(Some(value))?
                .ok_or_else(|| invalid_request("Queued message update is invalid."))?,
        ),
    };
    Ok(SessionQueueUpdateRequest {
        content_parts,
        text,
        plan_id: optional_string(object, "plan_id")?,
        attachments: attachments.map(|items| {
            items
                .into_iter()
                .filter_map(|item| {
                    item.get("file_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect()
        }),
        model: optional_string(object, "model")?,
        reasoning_effort: optional_string(object, "reasoning_effort")?,
        access_mode: optional_string(object, "access_mode")?,
        plan_mode: optional_bool(object, "plan_mode")?,
    })
}

fn strict_attachments(value: Option<&Value>) -> Result<Option<Vec<Value>>, HttpError> {
    let Some(value) = value else { return Ok(None) };
    let Some(items) = value.as_array() else {
        return Err(invalid_request("Queued message attachments are invalid."));
    };
    let mut result = Vec::with_capacity(items.len());
    for item in items {
        let file_id = item
            .get("file_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| invalid_request("Queued message attachments are invalid."))?;
        result.push(Value::Object(Map::from_iter([(
            "file_id".to_owned(),
            Value::String(file_id.to_owned()),
        )])));
    }
    Ok(Some(result))
}

fn optional_string_value(
    object: &Map<String, Value>,
    key: &str,
    message: &str,
) -> Result<Option<Value>, HttpError> {
    match object.get(key) {
        None => Ok(None),
        Some(value) if value.is_string() => Ok(Some(value.clone())),
        Some(_) => Err(invalid_request(message)),
    }
}

fn optional_bool_value(
    object: &Map<String, Value>,
    key: &str,
    message: &str,
) -> Result<Option<Value>, HttpError> {
    match object.get(key) {
        None => Ok(None),
        Some(value) if value.is_boolean() => Ok(Some(value.clone())),
        Some(_) => Err(invalid_request(message)),
    }
}

fn optional_string(object: &Map<String, Value>, key: &str) -> Result<Option<String>, HttpError> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| invalid_request("Queued message update is invalid."))
            .map(Some),
    }
}

fn optional_bool(object: &Map<String, Value>, key: &str) -> Result<Option<bool>, HttpError> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| invalid_request("Queued message update is invalid."))
            .map(Some),
    }
}

fn parse_content(value: &Value) -> Result<MessageContent, HttpError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid_request("Queued message content is invalid."))?;
    if object.get("version").and_then(Value::as_f64) != Some(1.0)
        || !object
            .get("parts")
            .and_then(Value::as_array)
            .is_some_and(|parts| parts.len() <= 1_000 && parts.iter().all(valid_content_part))
    {
        return Err(invalid_request("Queued message content is invalid."));
    }
    let mut normalized = value.clone();
    crate::json::object_mut(&mut normalized).insert("version".to_owned(), Value::from(1));
    serde_json::from_value(normalized)
        .map_err(|_| invalid_request("Queued message content is invalid."))
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
            .is_some_and(|text| !text.is_empty() && text.encode_utf16().count() <= max)
    };
    let topic_valid = part.get("topic").is_none_or(|topic| {
        topic
            .as_str()
            .is_some_and(|text| !text.trim().is_empty() && text.encode_utf16().count() <= 80)
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
        .is_some_and(|id| !id.is_empty() && id.encode_utf16().count() <= 256);
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
            .is_some_and(|text| text.encode_utf16().count() <= 500)
        && topic_valid
        && kind_valid
        && id_valid
        && revision_valid
}

fn content_text(content: &MessageContent) -> String {
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

fn invalid_request(message: &str) -> HttpError {
    HttpError::public(400, "invalid_request", message)
}

fn decode_component(encoded: &str) -> Result<String, HttpError> {
    let mut bytes = Vec::with_capacity(encoded.len());
    let mut source = encoded.as_bytes().iter().copied();
    while let Some(byte) = source.next() {
        if byte == b'%' {
            let high = source.next().and_then(hex);
            let low = source.next().and_then(hex);
            let (Some(high), Some(low)) = (high, low) else {
                return Err(invalid_request("Queued message id is invalid."));
            };
            bytes.push((high << 4) | low);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).map_err(|_| invalid_request("Queued message id is invalid."))
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
