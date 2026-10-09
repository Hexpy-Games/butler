mod anthropic_schema;
mod input;
mod messages;
mod reasoning;
mod stable;

use serde_json::{Map, Value};

use crate::models::ModelProviderMetadata;
use butler_turn::btcc::{
    ModelRoundMessage, ModelRoundRequest, ModelRoundRole, ModelRoundTool, ToolChoice,
};

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

#[cfg(any(test, feature = "test-support"))]
pub(super) fn body(
    request: &ModelRoundRequest<'_>,
    config: &ProviderRequestConfig,
    carrier: Carrier,
) -> Result<Value, butler_turn::btcc::ModelRoundError> {
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
) -> Result<(Value, Option<LegacyProjection>), butler_turn::btcc::ModelRoundError> {
    let mut continuation = (matches!(carrier, Carrier::Responses)
        && config.metadata.provider_id == "openai")
        .then(|| continuation::prepare(request))
        .transpose()?
        .flatten();
    let body = match carrier {
        Carrier::Responses => responses(request, config, continuation.as_mut())?,
        Carrier::Anthropic => anthropic(request, config),
        Carrier::Gemini => gemini(request),
        Carrier::Chat { stream } => chat(request, &config.metadata, &config.wire_model, stream)?,
    };
    Ok((body, continuation.map(|value| value.successful)))
}

/// Finish every content projection before placing Anthropic cache breakpoints.
pub(super) async fn body_with_visual(
    request: &ModelRoundRequest<'_>,
    config: &ProviderRequestConfig,
    carrier: Carrier,
) -> Result<(Value, Option<LegacyProjection>), butler_turn::btcc::ModelRoundError> {
    let (mut body, continuation) = body_with_continuation(request, config, carrier)?;
    super::visual::apply(&mut body, request, carrier).await?;
    if matches!(carrier, Carrier::Anthropic) {
        super::anthropic_cache::apply(
            &mut body,
            config,
            request
                .usage_attribution
                .and_then(|value| value.prompt_diagnostics.as_ref()),
        );
    }
    Ok((body, continuation))
}

fn responses(
    request: &ModelRoundRequest<'_>,
    config: &ProviderRequestConfig,
    continuation: Option<&mut LegacyPreparation>,
) -> Result<Value, butler_turn::btcc::ModelRoundError> {
    let mut body = response_controls(request, config);
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
    body.insert(
        "input".into(),
        input::response_input(request, config, continuation)?,
    );
    if let Some(stable) = request.stable_provider_cache_prefix {
        body = stable::order(body, stable, request.instructions)?;
    }
    apply_codex_controls(&mut body, request, config);
    Ok(Value::Object(body))
}

fn response_controls(
    request: &ModelRoundRequest<'_>,
    config: &ProviderRequestConfig,
) -> Map<String, Value> {
    let mut body = Map::new();
    if let Some(max) = request
        .max_output_tokens
        .filter(|value| js_truthy_number(*value))
    {
        body.insert("max_output_tokens".into(), max.into());
    }
    body.insert("model".into(), config.wire_model.as_str().into());
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
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        body.insert("instructions".into(), value.into());
    }
    body
}

fn apply_codex_controls(
    body: &mut Map<String, Value>,
    request: &ModelRoundRequest<'_>,
    config: &ProviderRequestConfig,
) {
    if matches!(
        config.auth.mode(),
        ProviderAuthMode::CodexOauth | ProviderAuthMode::CodexSubscription
    ) {
        body.insert(
            "model".into(),
            config
                .wire_model
                .strip_suffix("-codex")
                .unwrap_or(&config.wire_model)
                .into(),
        );
        if request
            .instructions
            .is_none_or(|value| butler_core::public_text::trim_js_whitespace(value).is_empty())
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
        body.entry("text")
            .or_insert_with(|| serde_json::json!({"verbosity":"medium"}));
    }
}

pub(super) use stable::identity as provider_cache_identity;

fn cache_scope(value: Option<&str>) -> String {
    let mut output = String::new();
    let mut dash = false;
    for character in
        butler_core::public_text::trim_js_whitespace(value.unwrap_or("btcc-agent-loop")).chars()
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

fn anthropic(request: &ModelRoundRequest<'_>, config: &ProviderRequestConfig) -> Value {
    let model = config.wire_model.as_str();
    let mut body = Map::new();
    body.insert("model".into(), model.into());
    if let Some(value) = request
        .instructions
        .map(butler_core::public_text::trim_js_whitespace)
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
        .and_then(|value| value.to_string().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(4096);
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
        .map(butler_core::public_text::trim_js_whitespace)
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
) -> Result<Value, butler_turn::btcc::ModelRoundError> {
    let mut body = Map::new();
    if !matches!(metadata.provider_id.as_str(), "kimi" | "qwen") {
        body.insert("temperature".into(), 0.into());
    }
    body.insert("model".into(), model.into());
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
            "kimi" if model == crate::models::KIMI_ADAPTIVE_MODEL => {
                body.insert("reasoning_effort".into(), reasoning.into());
            }
            "kimi" => {
                body.insert("thinking".into(), serde_json::json!({"type":"enabled"}));
            }
            _ => {}
        }
    } else if metadata.provider_id == "qwen" {
        body.insert("enable_thinking".into(), false.into());
    } else if metadata.provider_id == "kimi" && model != crate::models::KIMI_ADAPTIVE_MODEL {
        body.insert("thinking".into(), serde_json::json!({"type":"disabled"}));
    }
    if metadata.provider_id == "local" {
        body.extend(reasoning::local(metadata, request)?);
    }
    // Fixed schemas/options precede growing history so appends preserve the
    // physical request prefix rather than moving the entire tool catalog.
    body.insert(
        "messages".into(),
        Value::Array(if metadata.provider_id == "local" {
            messages::local_chat_messages(request)
        } else {
            messages::chat_messages(request)
        }),
    );
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
    anthropic_schema::tool(tool)
}
fn gemini_tool(tool: &ModelRoundTool) -> Value {
    serde_json::json!({"name":tool.name,"description":tool.description,"parameters":tool.parameters})
}
