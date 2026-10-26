//! Proactive settings projection, validation and monotone introduction flag.
use super::update::invalid_settings;
use crate::gateway::GatewayApplicationError;
use serde_json::{Map, Value, json};
pub(super) const KEYS: &[&str] = &[
    "proactive_level",
    "quiet_hours_start",
    "quiet_hours_end",
    "chats_intro_seen",
];

pub(super) fn valid(input: &Value) -> bool {
    input
        .get("proactive_level")
        .is_none_or(|v| matches!(v.as_str(), Some("off" | "sometimes" | "often")))
        && ["quiet_hours_start", "quiet_hours_end"].iter().all(|key| {
            input
                .get(key)
                .is_none_or(|v| v.as_str().is_some_and(super::validation::valid_time_of_day))
        })
        && input
            .get("chats_intro_seen")
            .is_none_or(|v| v == &Value::Bool(true))
}
pub(super) fn validate_window(
    input: &Value,
    current: &Value,
) -> Result<(), GatewayApplicationError> {
    let start = input
        .get("quiet_hours_start")
        .or_else(|| current.get("quiet_hours_start"))
        .and_then(Value::as_str)
        .unwrap_or("22:00");
    let end = input
        .get("quiet_hours_end")
        .or_else(|| current.get("quiet_hours_end"))
        .and_then(Value::as_str)
        .unwrap_or("07:00");
    if start == end {
        Err(invalid_settings())
    } else {
        Ok(())
    }
}
pub(super) fn copy(input: &Value, output: &mut Value) {
    for key in KEYS {
        if let Some(v) = input.get(key) {
            output[*key] = v.clone();
        }
    }
}
pub(super) fn view(native: &Map<String, Value>, output: &mut Map<String, Value>) {
    let values = native
        .get("proactive_settings")
        .cloned()
        .unwrap_or(json!({}));
    for (key, default) in [
        ("proactive_level", json!("sometimes")),
        ("quiet_hours_start", json!("22:00")),
        ("quiet_hours_end", json!("07:00")),
        ("chats_intro_seen", json!(false)),
    ] {
        output.insert(
            key.into(),
            values
                .get(key)
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(default),
        );
    }
}
