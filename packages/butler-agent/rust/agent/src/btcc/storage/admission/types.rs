use serde_json::{Map, Value};

use crate::btcc::storage::StorageResult;
use crate::btcc::storage::common::error;

pub(super) struct Inbox {
    pub(super) inbox_id: String,
    pub(super) turn_id: String,
    pub(super) admission_input_hash: String,
    pub(super) status: String,
    pub(super) command_json: String,
}

pub(super) struct AdmissionClaim {
    pub(super) claim_id: String,
}
pub(super) fn kind(value: &Value) -> StorageResult<&str> {
    text(value, "kind")
}
pub(super) fn object<'a>(value: &'a Value, key: &str) -> StorageResult<&'a Map<String, Value>> {
    value
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| error("invalid_turn_command", format!("missing object: {key}")))
}
pub(super) fn text<'a>(value: &'a Value, key: &str) -> StorageResult<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| error("invalid_turn_command", format!("missing text: {key}")))
}
pub(super) fn text_object<'a>(value: &'a Map<String, Value>, key: &str) -> StorageResult<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| error("invalid_turn_command", format!("missing text: {key}")))
}
pub(super) fn optional_text_object<'a>(
    value: &'a Map<String, Value>,
    key: &str,
) -> StorageResult<Option<&'a str>> {
    match value.get(key) {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .map(Some)
            .ok_or_else(|| error("invalid_turn_command", format!("invalid text: {key}"))),
    }
}
