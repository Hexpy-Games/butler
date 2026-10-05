use super::*;

pub(super) fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value
            .as_f64()
            .is_some_and(|value| value != 0.0 && !value.is_nan()),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

pub(super) fn json(value: &Value) -> Result<String, BtccError> {
    butler_core::json::stringify(value).map_err(|error| {
        BtccError::relayed("guided_prompt_json_invalid", error.to_string()).with_source(error)
    })
}

pub(super) fn nonempty_array(turn: &TurnRecord, field: &str) -> bool {
    turn.context
        .get(field)
        .and_then(Value::as_array)
        .is_some_and(|value| !value.is_empty())
}
