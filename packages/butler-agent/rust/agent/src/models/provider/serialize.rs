mod messages;
mod reasoning;
mod stable;

use serde_json::{Map, Value};

use crate::btcc::{
    ModelRoundMessage, ModelRoundRequest, ModelRoundRole, ModelRoundTool, ToolChoice,
};
use crate::models::ModelProviderMetadata;

use super::continuation::{self, LegacyPreparation, LegacyProjection};
use super::contracts::{PromptCacheRetention, ProviderAuthMode, ProviderRequestConfig};

#[derive(Clone, Copy)]
pub(super) enum Carrier {
    Responses,
    Anthropic,
    Gemini,
    Chat { stream: bool },
}

pub(super) fn bounded_items(messages: &[ModelRoundMessage]) -> Vec<Value> {
    messages::bounded_items(messages)
}

#[cfg(test)]
pub(super) fn body(
    request: &ModelRoundRequest<'_>,
    config: &ProviderRequestConfig,
    carrier: Carrier,
) -> Result<Value, crate::btcc::ModelRoundError> {
    body_with_continuation(request, config, carrier).map(|(body, _)| body)
}

pub(super) fn requested_output_tokens(
    body: &Value,
    carrier: Carrier,
    codex_attribution: Option<f64>,
) -> Option<f64> {
    if codex_attribution.is_some() {
        return codex_attribution;
    }
    match carrier {
        Carrier::Responses => body.get("max_output_tokens"),
        Carrier::Anthropic | Carrier::Chat { .. } => body.get("max_tokens"),
        Carrier::Gemini => body.pointer("/generationConfig/maxOutputTokens"),
    }
    .and_then(Value::as_f64)
}

pub(super) fn body_with_continuation(
    request: &ModelRoundRequest<'_>,
    config: &ProviderRequestConfig,
    carrier: Carrier,
) -> Result<(Value, Option<LegacyProjection>), crate::btcc::ModelRoundError> {
    let mut continuation = (matches!(carrier, Carrier::Responses)
        && config.metadata.provider_id == "openai")
        .then(|| continuation::prepare(request))
        .transpose()?
        .flatten();
    let body = match carrier {
        Carrier::Responses => responses(request, config, continuation.as_mut())?,
        Carrier::Anthropic => anthropic(request, &config.metadata, &config.wire_model),
        Carrier::Gemini => gemini(request),
        Carrier::Chat { stream } => chat(request, &config.metadata, &config.wire_model, stream)?,
    };
    Ok((body, continuation.map(|value| value.successful)))
}

fn responses(
    request: &ModelRoundRequest<'_>,
    config: &ProviderRequestConfig,
    mut continuation: Option<&mut LegacyPreparation>,
) -> Result<Value, crate::btcc::ModelRoundError> {
    let model = &config.wire_model;
    let mut body = Map::new();
    if let Some(max) = request
        .max_output_tokens
        .filter(|value| js_truthy_number(*value))
    {
        body.insert("max_output_tokens".into(), max.into());
    }
    body.insert("model".into(), model.as_str().into());
    if config.metadata.provider_id == "openai" {
        body.insert("store".into(), true.into());
        if let Some(prefix) = config.prompt_cache.key_prefix.as_deref() {
            let scope = cache_scope(request.cache_scope);
            body.insert(
                "prompt_cache_key".into(),
                if scope.is_empty() {
                    prefix.into()
                } else {
                    format!("{prefix}:{scope}").into()
                },
            );
        }
        if let Some(retention) = config.prompt_cache.retention {
            body.insert(
                "prompt_cache_retention".into(),
                match retention {
                    PromptCacheRetention::InMemory => "in_memory",
                    PromptCacheRetention::Hours24 => "24h",
                }
                .into(),
            );
        }
        if let Some(value) = request.instructions {
            body.insert("instructions".into(), value.into());
        }
    } else if let Some(value) = request
        .instructions
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        body.insert("instructions".into(), value.into());
    }
    if !request.tools.is_empty() {
        body.insert(
            "tools".into(),
            Value::Array(request.tools.iter().map(response_tool).collect()),
        );
    }
    body.insert("tool_choice".into(), choice(request.tool_choice).into());
    if let Some(reasoning) = reasoning::effort(request) {
        body.insert("reasoning".into(), serde_json::json!({"effort":reasoning}));
    }
    if let Some(response_id) = request
        .continuation
        .filter(|value| continuation::is_openai(value))
        .and_then(|value| value.get("responseId"))
        .and_then(Value::as_str)
    {
        body.insert("previous_response_id".into(), response_id.into());
    }
    let input = if config.metadata.provider_id == "openai" {
        continuation
            .as_deref_mut()
            .map(|value| std::mem::take(&mut value.request_items))
            .unwrap_or(openai_input(request)?)
    } else {
        Value::Array(messages::response_items(request))
    };
    body.insert("input".into(), input);
    if config.metadata.provider_id == "openai"
        && matches!(
            config.auth.mode(),
            ProviderAuthMode::CodexOauth | ProviderAuthMode::CodexSubscription
        )
    {
        body.insert(
            "__butler_codex_stateless_input".into(),
            continuation
                .map(|value| Value::Array(value.successful.stateless_request_input.clone()))
                .unwrap_or_else(|| Value::Array(messages::bounded_items(request.messages))),
        );
    }
    if let Some(stable) = request.stable_provider_cache_prefix {
        body = stable::order(body, stable, request.instructions)
            .map_err(|code| crate::btcc::ModelRoundError::StablePrefix(code.into()))?;
    }
    if matches!(
        config.auth.mode(),
        ProviderAuthMode::CodexOauth | ProviderAuthMode::CodexSubscription
    ) {
        body.insert(
            "model".into(),
            model.strip_suffix("-codex").unwrap_or(model).into(),
        );
        if request
            .instructions
            .is_none_or(|value| crate::public_text::trim_js_whitespace(value).is_empty())
        {
            body.insert(
                "instructions".into(),
                "You are Butler, a helpful personal AI assistant.".into(),
            );
        }
        body.insert("store".into(), false.into());
        body.insert("stream".into(), true.into());
        body.shift_remove("prompt_cache_retention");
        body.shift_remove("max_output_tokens");
        body.shift_remove("previous_response_id");
        if let Some(stateless) = body.shift_remove("__butler_codex_stateless_input") {
            body.insert("input".into(), stateless);
        }
        body.entry("text")
            .or_insert_with(|| serde_json::json!({"verbosity":"medium"}));
    }
    Ok(Value::Object(body))
}

pub(super) use stable::identity as provider_cache_identity;

fn openai_input(request: &ModelRoundRequest<'_>) -> Result<Value, crate::btcc::ModelRoundError> {
    if let Some(bounded) = request.bounded_continuation {
        let response = bounded
            .get("responseItemId")
            .and_then(Value::as_str)
            .and_then(|value| messages::turn_item_ordinal(Some(value)).ok())
            .ok_or_else(|| continuation_error("bounded_continuation_turn_item_identity_missing"))?;
        let previous = request
            .continuation
            .filter(|value| continuation::is_openai(value));
        if previous.is_some_and(|value| value.get("deliveredThroughOrdinal").is_none()) {
            return Err(continuation_error("bounded_continuation_watermark_missing"));
        }
        let delivered = previous
            .map(|value| {
                value
                    .get("deliveredThroughOrdinal")
                    .and_then(Value::as_u64)
                    .filter(|value| *value <= 1_000_000)
                    .ok_or_else(|| continuation_error("bounded_continuation_watermark_invalid"))
            })
            .transpose()?
            .map_or(-1_i64, |value| i64::try_from(value).unwrap_or(i64::MAX));
        let (items, ordinals) =
            messages::bounded_items_with_ordinals(request.messages).map_err(continuation_error)?;
        if i64::try_from(response).unwrap_or(i64::MAX) <= delivered
            || ordinals.iter().any(|value| *value >= response)
            || ordinals.windows(2).any(|pair| pair[1] < pair[0])
        {
            return Err(continuation_error(
                "bounded_continuation_item_identity_invalid",
            ));
        }
        return Ok(Value::Array(
            items
                .into_iter()
                .zip(ordinals)
                .filter_map(|(item, ordinal)| {
                    (i64::try_from(ordinal).unwrap_or(i64::MAX) > delivered).then_some(item)
                })
                .collect(),
        ));
    }
    if let Some(previous) = request.continuation
        && continuation::is_openai(previous)
    {
        let sent_tools = previous
            .pointer("/sent/toolMessages")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let sent_users = previous
            .pointer("/sent/userMessages")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let mut tools = 0;
        let mut users = 0;
        let items = request.messages.iter().filter_map(|message| match message.role {
            ModelRoundRole::Tool => {
                tools += 1;
                (tools > sent_tools).then(|| serde_json::json!({"type":"function_call_output","call_id":message.tool_call_id,"output":message.content}))
            }
            ModelRoundRole::User => {
                users += 1;
                (users > sent_users).then(|| serde_json::json!({"role":"user","content":[{"type":"input_text","text":message.content}]}))
            }
            _ => None,
        }).collect();
        return Ok(Value::Array(items));
    }
    Ok(request
        .messages
        .iter()
        .find(|message| message.role == ModelRoundRole::User)
        .map(|message| Value::String(message.content.as_ref().to_owned()))
        .unwrap_or(Value::String(String::new())))
}

fn continuation_error(code: &'static str) -> crate::btcc::ModelRoundError {
    crate::btcc::ModelRoundError::Integrity(crate::btcc::BtccError::new(code, code))
}

fn cache_scope(value: Option<&str>) -> String {
    let mut output = String::new();
    let mut dash = false;
    for character in
        crate::public_text::trim_js_whitespace(value.unwrap_or("btcc-agent-loop")).chars()
    {
        if character.is_ascii_alphanumeric() || "._:-".contains(character) {
            output.push(character);
            dash = false;
        } else if !dash {
            output.push('-');
            dash = true;
        }
    }
    output.trim_matches(['-', ':']).to_owned()
}

fn anthropic(
    request: &ModelRoundRequest<'_>,
    _metadata: &ModelProviderMetadata,
    model: &str,
) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), model.into());
    if let Some(value) = request
        .instructions
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        body.insert("system".into(), value.into());
    }
    if let Some(reasoning) = reasoning::anthropic(model, request) {
        for (key, value) in reasoning {
            body.insert(key, value);
        }
    }
    let max = request
        .max_output_tokens
        .filter(|value| js_truthy_number(*value))
        .unwrap_or(4096.0);
    body.insert("max_tokens".into(), max.into());
    body.insert(
        "messages".into(),
        Value::Array(messages::anthropic_messages(request)),
    );
    if !request.tools.is_empty() {
        body.insert(
            "tools".into(),
            Value::Array(request.tools.iter().map(anthropic_tool).collect()),
        );
    }
    if request.tool_choice == Some(ToolChoice::Required) {
        body.insert("tool_choice".into(), serde_json::json!({"type":"any"}));
    }
    Value::Object(body)
}

fn gemini(request: &ModelRoundRequest<'_>) -> Value {
    let mut body = Map::new();
    if let Some(value) = request
        .instructions
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        body.insert(
            "systemInstruction".into(),
            serde_json::json!({"parts":[{"text":value}]}),
        );
    }
    let mut generation = Map::new();
    if let Some(max) = request
        .max_output_tokens
        .filter(|value| js_truthy_number(*value))
    {
        generation.insert("maxOutputTokens".into(), max.into());
    }
    generation.insert(
        "thinkingConfig".into(),
        serde_json::json!({"thinkingLevel":reasoning::gemini_level(request.reasoning_effort)}),
    );
    if !generation.is_empty() {
        body.insert("generationConfig".into(), generation.into());
    }
    body.insert(
        "contents".into(),
        Value::Array(messages::gemini_messages(request)),
    );
    if !request.tools.is_empty() {
        body.insert("tools".into(), serde_json::json!([{"functionDeclarations":request.tools.iter().map(gemini_tool).collect::<Vec<_>>() }]));
    }
    if request.tool_choice == Some(ToolChoice::Required) {
        body.insert(
            "toolConfig".into(),
            serde_json::json!({"functionCallingConfig":{"mode":"ANY"}}),
        );
    }
    Value::Object(body)
}

fn chat(
    request: &ModelRoundRequest<'_>,
    metadata: &ModelProviderMetadata,
    model: &str,
    stream: bool,
) -> Result<Value, crate::btcc::ModelRoundError> {
    let mut body = Map::new();
    if !matches!(metadata.provider_id.as_str(), "kimi" | "qwen") {
        body.insert("temperature".into(), 0.into());
    }
    body.insert("model".into(), model.into());
    body.insert(
        "messages".into(),
        Value::Array(if metadata.provider_id == "local" {
            messages::local_chat_messages(request)
        } else {
            messages::chat_messages(request)
        }),
    );
    if let Some(max) = request
        .max_output_tokens
        .filter(|value| js_truthy_number(*value))
    {
        body.insert("max_tokens".into(), max.into());
    }
    if !request.tools.is_empty() {
        body.insert(
            "tools".into(),
            Value::Array(request.tools.iter().map(chat_tool).collect()),
        );
    }
    body.insert("tool_choice".into(), choice(request.tool_choice).into());
    body.insert("stream".into(), stream.into());
    if let Some(reasoning) = reasoning::effort(request) {
        match metadata.provider_id.as_str() {
            "xai" | "zai" | "zai-api" => {
                body.insert("reasoning_effort".into(), reasoning.into());
            }
            "qwen" => {
                body.insert("enable_thinking".into(), true.into());
            }
            "kimi" if model == "kimi-k3" => {
                body.insert("reasoning_effort".into(), reasoning.into());
            }
            "kimi" => {
                body.insert("thinking".into(), serde_json::json!({"type":"enabled"}));
            }
            _ => {}
        }
    } else if metadata.provider_id == "qwen" {
        body.insert("enable_thinking".into(), false.into());
    } else if metadata.provider_id == "kimi" && model != "kimi-k3" {
        body.insert("thinking".into(), serde_json::json!({"type":"disabled"}));
    }
    if metadata.provider_id == "local" {
        body.extend(reasoning::local(metadata, request)?);
    }
    Ok(Value::Object(body))
}

fn js_truthy_number(value: f64) -> bool {
    value != 0.0 && !value.is_nan()
}

fn choice(value: Option<ToolChoice>) -> &'static str {
    if value == Some(ToolChoice::Required) {
        "required"
    } else {
        "auto"
    }
}
fn response_tool(tool: &ModelRoundTool) -> Value {
    serde_json::json!({"type":"function","name":tool.name,"description":tool.description,"parameters":tool.parameters,"strict":false})
}
fn chat_tool(tool: &ModelRoundTool) -> Value {
    serde_json::json!({"type":"function","function":{"name":tool.name,"description":tool.description,"parameters":tool.parameters}})
}
fn anthropic_tool(tool: &ModelRoundTool) -> Value {
    serde_json::json!({"name":tool.name,"description":tool.description,"input_schema":tool.parameters})
}
fn gemini_tool(tool: &ModelRoundTool) -> Value {
    serde_json::json!({"name":tool.name,"description":tool.description,"parameters":tool.parameters})
}
