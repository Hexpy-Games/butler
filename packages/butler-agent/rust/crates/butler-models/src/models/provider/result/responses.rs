//! Responses decoding, including the plan namespace call-name projection.
use super::*;
pub(super) fn decode(value: &Value, model: &str, provider: &str, round: u32) -> Fields {
    let output = value
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = value
        .get("output_text")
        .and_then(Value::as_str)
        .filter(|value| !butler_core::public_text::trim_js_whitespace(value).is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            output
                .iter()
                .filter_map(|item| item.get("content").and_then(Value::as_array))
                .flatten()
                .filter(|item| item.get("type").and_then(Value::as_str) == Some("output_text"))
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        });
    let calls = output
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .enumerate()
        .filter_map(|(index, item)| {
            call(
                item.get("call_id"),
                Some(&Value::String(
                    super::super::chatgpt_plan::call_name(item).into(),
                )),
                item.get("arguments"),
                index,
            )
        })
        .collect();
    (
        join_text(text),
        calls,
        Some(Value::Array(output)),
        (provider == "openai")
            .then(|| openai_usage(value, model, round))
            .flatten(),
        value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
    )
}
