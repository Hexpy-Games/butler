use serde_json::Value;

use crate::{btcc::AccessMode, gateway::application::storage::AppStorageError};

pub(super) fn parse_access(value: &str) -> Option<AccessMode> {
    match value {
        "ask_first" => Some(AccessMode::AskFirst),
        "read_only" => Some(AccessMode::ReadOnly),
        "full_access" => Some(AccessMode::FullAccess),
        _ => None,
    }
}

pub(super) fn json_type(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "object",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_) | Value::Object(_)) => "object",
    }
}

pub(super) fn safe_integer(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number.is_finite()
        && number >= 0.0
        && number.fract() == 0.0
        && number <= 9_007_199_254_740_991.0)
        .then_some(crate::json::saturating_u64(number))
}

pub(super) fn invalid_resolution() -> AppStorageError {
    AppStorageError::new(
        "turn_control_resolution_invalid",
        "Turn controls are unavailable.",
    )
}
