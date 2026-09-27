//! Unknown-field-preserving OAuth profile updates.

use serde_json::{Map, Value};

pub(crate) struct OpenAiAuthProfile {
    pub(super) raw: Map<String, Value>,
    pub(super) access_token: String,
    pub(super) refresh_token: Option<String>,
    pub(super) expires_at: Option<f64>,
}

impl OpenAiAuthProfile {
    pub(crate) fn as_json(&self) -> Value {
        Value::Object(self.raw.clone())
    }
}

pub(super) fn update_string(raw: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value.and_then(Value::as_str) {
        raw.insert(key.into(), value.into());
    }
}

pub(super) fn copy_string(raw: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    update_string(raw, key, value);
}

pub(super) fn update_number(
    raw: &mut Map<String, Value>,
    key: &str,
    value: Option<&Value>,
    now: i64,
) {
    if let Some(seconds) = value.and_then(Value::as_f64)
        && let Some(number) = serde_json::Number::from_f64(now as f64 + seconds * 1000.0)
    {
        raw.insert(key.into(), Value::Number(number));
    }
}

pub(super) fn update_claim(raw: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        raw.insert(key.into(), value.into());
    }
}
