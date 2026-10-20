use butler_turn::btcc::ModelRoundToolCall;
use serde_json::Value;

pub(super) fn call(
    id: Option<&Value>,
    name: Option<&Value>,
    arguments: Option<&Value>,
    index: usize,
) -> Option<ModelRoundToolCall> {
    let id = id
        .and_then(Value::as_str)
        .map(str::to_owned)
        // Accepted rounds persist this id with the decoded call; replay never regenerates it.
        .unwrap_or_else(|| format!("local_call_{index}_{}", uuid::Uuid::new_v4()));
    let name = name?.as_str()?.to_owned();
    let raw = arguments
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| arguments.and_then(|value| butler_core::json::stringify(value).ok()))
        .unwrap_or_else(|| "{}".into());
    let parsed = butler_turn::btcc::decode_object(&raw).unwrap_or_default();
    Some(ModelRoundToolCall {
        id,
        name,
        arguments: parsed,
        raw_arguments: raw,
        origin: None,
    })
}
