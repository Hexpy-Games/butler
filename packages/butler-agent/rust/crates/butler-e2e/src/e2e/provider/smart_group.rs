//! Explicit stub contract for background smart-group classification.
//! These requests are traced apart from interactive requests, so scenarios
//! that count model calls are unaffected by sidebar organization.
use super::super::cassette::ResponseRecord;
use super::title_response;
use butler_gateway::gateway::SMART_GROUP_INSTRUCTIONS;
use serde_json::Value;

/// Files nothing: the reply a model gives when no subject is clear.
pub const NO_SMART_GROUP: &str = r#"{"topic":null,"action":"none","target":null}"#;

pub fn is_smart_group_request(request: &Value) -> bool {
    request["instructions"].as_str() == Some(SMART_GROUP_INSTRUCTIONS)
        && request["tools"].as_array().is_none_or(Vec::is_empty)
}

/// The classification input (`message`, `truncated`, `candidates`) the App sent.
pub fn smart_group_input(request: &Value) -> Option<Value> {
    request["input"]
        .as_array()?
        .iter()
        .find(|item| item["role"] == "user")
        .and_then(|item| match &item["content"] {
            Value::String(text) => Some(text.clone()),
            Value::Array(parts) => parts
                .iter()
                .find_map(|part| part["text"].as_str().map(str::to_owned)),
            _ => None,
        })
        .and_then(|text| serde_json::from_str(&text).ok())
}

/// A classification reply carrying `text` as the model's whole answer.
pub fn smart_group_response(text: &str) -> ResponseRecord {
    title_response(text)
}
