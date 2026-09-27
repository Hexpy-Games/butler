use serde_json::{Map, Value};

use crate::btcc::{
    ModelRoundMessage, ModelRoundRequest, ModelRoundResult, ModelRoundRole, ModelRoundToolCall,
    ProviderIdentity,
};

use super::continuation::LegacyProjection;
use super::serialize::Carrier;

pub(super) fn decode(
    response: Value,
    provider: &str,
    configured_model: &str,
    carrier: Carrier,
    round_index: u32,
    request: &ModelRoundRequest<'_>,
    legacy_projection: Option<LegacyProjection>,
) -> ModelRoundResult {
    let (mut text, mut calls, provider_data, usage, reported) = match carrier {
        Carrier::Responses => responses(&response, configured_model, provider, round_index),
        Carrier::Anthropic => anthropic(&response, configured_model),
        Carrier::Gemini => gemini(&response, configured_model, round_index),
        Carrier::Chat { .. } => chat(&response, configured_model),
    };
    let mut text_tool_call_names = Vec::new();
    if provider == "local" {
        (text, calls, text_tool_call_names) = local::decode(&response, request);
    }
    let identity = reported
        .filter(|value| !crate::public_text::trim_js_whitespace(value).is_empty())
        .map(|reported_model| ProviderIdentity {
            provider: provider.into(),
            configured_model: configured_model.into(),
            reported_model: crate::public_text::trim_js_whitespace(&reported_model).into(),
        });
    let assistant_message = Some(ModelRoundMessage {
        role: ModelRoundRole::Assistant,
        content: text.clone().unwrap_or_default().into(),
        tool_call_id: None,
        name: None,
        tool_calls: Some(calls.clone()),
        image_attachments: Vec::new(),
        provider_data,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: None,
    });
    let continuation =
        (provider == "openai").then(|| openai_continuation(&response, request, legacy_projection));
    ModelRoundResult {
        text,
        tool_calls: calls,
        text_tool_call_names,
        assistant_message,
        continuation,
        usage,
        provider_identity: identity,
        raw: Some(response),
        accepted_checkpoint: None,
    }
}

fn openai_continuation(
    response: &Value,
    request: &ModelRoundRequest<'_>,
    legacy_projection: Option<LegacyProjection>,
) -> Value {
    let mut output = Map::new();
    output.insert("provider".into(), "openai".into());
    output.insert(
        "responseId".into(),
        response
            .get("id")
            .cloned()
            .unwrap_or(Value::String(String::new())),
    );
    if let Some(bounded) = request.bounded_continuation {
        if let Some(ordinal) = bounded
            .get("responseItemId")
            .and_then(Value::as_str)
            .and_then(turn_item_ordinal)
        {
            output.insert("deliveredThroughOrdinal".into(), ordinal.into());
        }
        if let Some(value) = bounded.get("contextProjection") {
            output.insert("contextProjection".into(), value.clone());
        }
    } else {
        let (stateless, tool_messages, user_messages) = if let Some(projection) = legacy_projection
        {
            super::continuation::successful(projection, response)
        } else {
            let mut stateless = super::serialize::bounded_items(request.messages);
            if let Some(items) = response.get("output").and_then(Value::as_array) {
                stateless.extend(
                    items
                        .iter()
                        .filter(|item| {
                            item.get("type").and_then(Value::as_str) == Some("function_call")
                        })
                        .cloned(),
                );
            }
            let tools = request
                .messages
                .iter()
                .filter(|message| message.role == ModelRoundRole::Tool)
                .count() as u64;
            let users = request
                .messages
                .iter()
                .filter(|message| message.role == ModelRoundRole::User)
                .count() as u64;
            (stateless, tools, users)
        };
        output.insert(
            "sent".into(),
            serde_json::json!({"toolMessages":tool_messages,"userMessages":user_messages}),
        );
        output.insert("statelessInput".into(), Value::Array(stateless));
    }
    Value::Object(output)
}

fn turn_item_ordinal(value: &str) -> Option<u64> {
    let value = value.strip_prefix("turn-item-")?;
    if value.len() > 7 || (value.len() > 1 && value.starts_with('0')) {
        return None;
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= 1_000_000)
}

fn responses(value: &Value, model: &str, provider: &str, round: u32) -> Fields {
    let output = value
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = value
        .get("output_text")
        .and_then(Value::as_str)
        .filter(|value| !crate::public_text::trim_js_whitespace(value).is_empty())
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
        .filter_map(|item| call(item.get("call_id"), item.get("name"), item.get("arguments")))
        .collect();
    (
        nonempty(text),
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

fn anthropic(value: &Value, model: &str) -> Fields {
    let content = value
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = content
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    let calls = content
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|item| call(item.get("id"), item.get("name"), item.get("input")))
        .collect();
    (
        nonempty(text),
        calls,
        Some(Value::Array(content)),
        provider_usage(
            model,
            number(value.pointer("/usage/input_tokens")).map(|input| {
                input
                    + number(value.pointer("/usage/cache_read_input_tokens")).unwrap_or(0.0)
                    + number(value.pointer("/usage/cache_creation_input_tokens")).unwrap_or(0.0)
            }),
            number(value.pointer("/usage/cache_read_input_tokens")).unwrap_or(0.0),
            number(value.pointer("/usage/output_tokens")).unwrap_or(0.0),
            None,
        ),
        value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
    )
}

fn gemini(value: &Value, model: &str, round: u32) -> Fields {
    let parts = value
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = parts
        .iter()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    let calls = parts
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let function = item.get("functionCall")?;
            let name = function.get("name")?.as_str()?;
            let id = Value::String(format!("gemini_call_{round}_{index}_{name}"));
            call(
                Some(&id),
                Some(&Value::String(name.into())),
                function.get("args"),
            )
        })
        .collect();
    let reported = value
        .get("modelVersion")
        .or_else(|| value.get("model"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    (
        nonempty(text),
        calls,
        Some(Value::Array(parts)),
        provider_usage(
            model,
            number(value.pointer("/usageMetadata/promptTokenCount")),
            number(value.pointer("/usageMetadata/cachedContentTokenCount")).unwrap_or(0.0),
            number(value.pointer("/usageMetadata/candidatesTokenCount")).unwrap_or(0.0),
            number(value.pointer("/usageMetadata/totalTokenCount")),
        ),
        reported,
    )
}

fn chat(value: &Value, model: &str) -> Fields {
    let message = value
        .pointer("/choices/0/message")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let text = message
        .get("content")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .and_then(nonempty);
    let calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            call(
                item.get("id"),
                item.pointer("/function/name"),
                item.pointer("/function/arguments"),
            )
        })
        .collect();
    (
        text,
        calls,
        Some(message),
        provider_usage(
            model,
            number(value.pointer("/usage/prompt_tokens"))
                .or_else(|| number(value.pointer("/usage/input_tokens"))),
            number(value.pointer("/usage/prompt_tokens_details/cached_tokens"))
                .or_else(|| number(value.pointer("/usage/input_tokens_details/cached_tokens")))
                .unwrap_or(0.0),
            number(value.pointer("/usage/completion_tokens"))
                .or_else(|| number(value.pointer("/usage/output_tokens")))
                .unwrap_or(0.0),
            number(value.pointer("/usage/total_tokens")),
        ),
        value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
    )
}

type Fields = (
    Option<String>,
    Vec<ModelRoundToolCall>,
    Option<Value>,
    Option<Value>,
    Option<String>,
);
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
pub(super) fn nonempty(value: String) -> Option<String> {
    let value = crate::public_text::trim_js_whitespace(&value);
    if value.is_empty() {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    let open = "<butler_final_answer>";
    let close = "</butler_final_answer>";
    if let Some(start) = lower.rfind(open) {
        let body = &value[start + open.len()..];
        let end = body.to_ascii_lowercase().find(close).unwrap_or(body.len());
        let selected = crate::public_text::trim_js_whitespace(&body[..end]);
        if !selected.is_empty() {
            return Some(selected.to_owned());
        }
    }
    Some(value.to_owned())
}

fn number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn provider_usage(
    model: &str,
    prompt: Option<f64>,
    cached: f64,
    output: f64,
    total: Option<f64>,
) -> Option<Value> {
    let total = total.or_else(|| prompt.map(|prompt| prompt + output));
    if prompt.is_none() && total.is_none() {
        return None;
    }
    Some(
        serde_json::json!({"model":model,"promptTokens":prompt,"cachedTokens":cached,"totalTokens":total,"outputTokens":output}),
    )
}

fn openai_usage(value: &Value, model: &str, round: u32) -> Option<Value> {
    let prompt = number(value.pointer("/usage/input_tokens"))
        .or_else(|| number(value.pointer("/usage/prompt_tokens")));
    let total = number(value.pointer("/usage/total_tokens"));
    let cached = number(value.pointer("/usage/prompt_tokens_details/cached_tokens"))
        .or_else(|| number(value.pointer("/usage/input_tokens_details/cached_tokens")));
    let cache_write = number(value.pointer("/usage/prompt_tokens_details/cache_write_tokens"))
        .or_else(|| number(value.pointer("/usage/input_tokens_details/cache_write_tokens")));
    if prompt.is_none() && total.is_none() && cached.is_none() && cache_write.is_none() {
        return None;
    }
    let output = match (total, prompt) {
        (Some(total), Some(prompt)) => (total - prompt).max(0.0),
        _ => 0.0,
    };
    Some(
        serde_json::json!({"model":model,"promptTokens":prompt,"cachedTokens":cached.unwrap_or(0.0),"totalTokens":total,"outputTokens":output,"roundIndex":round}),
    )
}
fn call(
    id: Option<&Value>,
    name: Option<&Value>,
    arguments: Option<&Value>,
) -> Option<ModelRoundToolCall> {
    let id = id?.as_str()?.to_owned();
    let name = name?.as_str()?.to_owned();
    let raw = arguments
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| arguments.and_then(|value| crate::json::stringify(value).ok()))
        .unwrap_or_else(|| "{}".into());
    let parsed = serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    Some(ModelRoundToolCall {
        id,
        name,
        arguments: parsed,
        raw_arguments: raw,
        origin: None,
    })
}
mod local;
