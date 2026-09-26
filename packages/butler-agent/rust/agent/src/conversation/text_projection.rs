//! Pure text projection of canonical conversation parts.

use serde_json::{Map, Value};

use crate::json::stringify;

use super::{ConversationMessageWithParts, ConversationPart, ConversationPartKind};

pub(crate) fn text_for_message(
    message: &ConversationMessageWithParts,
    include_tools: bool,
) -> String {
    message
        .parts
        .iter()
        .filter(|part| {
            include_tools
                || !matches!(
                    part.kind,
                    ConversationPartKind::ToolCall | ConversationPartKind::ToolResult
                )
        })
        .filter_map(text_for_part)
        .map(|text| crate::public_text::trim_js_whitespace(&text).to_owned())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn text_for_part(part: &ConversationPart) -> Option<String> {
    let object = part.content_json.as_object();
    match part.kind {
        ConversationPartKind::Text => object_string(object, "text"),
        ConversationPartKind::MessageContent => message_content_references(&part.content_json),
        ConversationPartKind::AttachmentRef => {
            let file_name =
                object_string(object, "fileName").or_else(|| object_string(object, "filename"));
            let id = object_string(object, "id");
            let label = [file_name, id]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(":");
            Some(format!(
                "[attachment:{}]",
                if label.is_empty() { "ref" } else { &label }
            ))
        }
        ConversationPartKind::SummaryRef => {
            object_string(object, "summary_id").or_else(|| Some("[summary_ref]".into()))
        }
        ConversationPartKind::ToolCall => Some(format!(
            "[tool_call:{}:{}]",
            object_string(object, "safeToolName")
                .or_else(|| object_string(object, "toolName"))
                .or_else(|| object_string(object, "name"))
                .unwrap_or_else(|| "tool".into()),
            part.tool_call_id.as_deref().unwrap_or("unknown")
        )),
        ConversationPartKind::ToolResult => {
            let label = object_string(object, "safeLabel")
                .or_else(|| object_string(object, "status"))
                .unwrap_or_else(|| {
                    if object
                        .and_then(|value| value.get("ok"))
                        .and_then(Value::as_bool)
                        == Some(false)
                    {
                        "failed".into()
                    } else {
                        "complete".into()
                    }
                });
            Some(format!(
                "[tool_result:{label}:{}]",
                part.parent_tool_call_id
                    .as_deref()
                    .or(part.tool_call_id.as_deref())
                    .unwrap_or("unknown")
            ))
        }
    }
}

fn message_content_references(value: &Value) -> Option<String> {
    let object = value.as_object()?;
    if object.get("version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let parts = object.get("parts")?.as_array()?;
    if parts.len() > 1000 || !parts.iter().all(valid_message_part) {
        return None;
    }
    let refs = parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("session_ref"))
        .cloned()
        .collect::<Vec<_>>();
    if refs.is_empty() {
        None
    } else {
        Some(format!(
            "[user session references: {}]",
            stringify(&Value::Array(refs)).ok()?
        ))
    }
}

fn valid_message_part(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    match object.get("type").and_then(Value::as_str) {
        Some("text") => object.get("text").is_some_and(Value::is_string),
        Some("session_ref") => {
            object
                .get("sessionId")
                .and_then(Value::as_str)
                .is_some_and(|value| !crate::public_text::trim_js_whitespace(value).is_empty())
                && object.get("titleSnapshot").is_some_and(Value::is_string)
        }
        Some("project_source_ref") => valid_project_ref(object),
        _ => false,
    }
}

fn valid_project_ref(object: &Map<String, Value>) -> bool {
    let text = |key| object.get(key).and_then(Value::as_str);
    let source = object.get("source").and_then(Value::as_object);
    let topic_valid = object.get("topic").is_none_or(|value| {
        value.as_str().is_some_and(|topic| {
            !crate::public_text::trim_js_whitespace(topic).is_empty()
                && topic.encode_utf16().count() <= 80
        })
    });
    text("projectId").is_some_and(|value| !value.is_empty() && value.encode_utf16().count() <= 256)
        && text("titleSnapshot").is_some_and(|value| value.encode_utf16().count() <= 500)
        && topic_valid
        && source.is_some_and(|source| {
            matches!(
                source.get("kind").and_then(Value::as_str),
                Some("work" | "task" | "plan" | "spec" | "report" | "message" | "reference")
            ) && source
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty() && value.encode_utf16().count() <= 256)
                && source
                    .get("revision")
                    .and_then(Value::as_str)
                    .is_some_and(|value| {
                        value.len() == 64
                            && value
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
                    })
        })
}

fn object_string(object: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    object?
        .get(key)?
        .as_str()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
