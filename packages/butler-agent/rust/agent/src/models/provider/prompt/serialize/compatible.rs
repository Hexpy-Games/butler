use serde_json::{Map, Value, json};

use crate::{
    btcc::ModelRoundError,
    models::{ProviderPromptRequest, ProviderRequestConfig, ReasoningEffort},
};

pub(super) fn anthropic(
    request: &ProviderPromptRequest<'_>,
    config: &ProviderRequestConfig,
    prompt: &str,
    reasoning: Option<ReasoningEffort>,
) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), config.wire_model.clone().into());
    body.insert(
        "max_tokens".into(),
        request
            .usage_attribution
            .and_then(|value| value.requested_output_tokens)
            .unwrap_or(4096.0)
            .into(),
    );
    if let Some(instructions) = request
        .instructions
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        body.insert("system".into(), instructions.into());
    }
    let claude5 = ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"]
        .iter()
        .any(|base| {
            config.wire_model == *base
                || config
                    .wire_model
                    .strip_prefix(base)
                    .and_then(|suffix| suffix.strip_prefix('-'))
                    .is_some_and(|version| {
                        !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit())
                    })
        });
    if claude5 {
        body.insert("thinking".into(), json!({"type":"adaptive"}));
        if let Some(reasoning) = reasoning.filter(|value| *value != ReasoningEffort::None) {
            body.insert(
                "output_config".into(),
                json!({"effort":super::effort(reasoning)}),
            );
        }
    } else if config.wire_model == "claude-haiku-4-5" {
        body.insert(
            "thinking".into(),
            reasoning
                .filter(|value| *value != ReasoningEffort::None)
                .map_or_else(
                    || json!({"type":"disabled"}),
                    |value| json!({"type":"enabled","budget_tokens":super::anthropic_budget(value)}),
                ),
        );
    }
    body.insert("messages".into(), json!([{"role":"user","content":prompt}]));
    Value::Object(body)
}

pub(super) fn gemini(
    request: &ProviderPromptRequest<'_>,
    _config: &ProviderRequestConfig,
    prompt: &str,
    reasoning: Option<ReasoningEffort>,
) -> Value {
    let mut body = Map::new();
    if let Some(instructions) = request
        .instructions
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        body.insert(
            "systemInstruction".into(),
            json!({"parts":[{"text":instructions}]}),
        );
    }
    let mut generation = Map::new();
    if let Some(reasoning) = reasoning {
        generation.insert(
            "thinkingConfig".into(),
            json!({"thinkingLevel":super::gemini_level(reasoning)}),
        );
    }
    if let Some(output) = request
        .usage_attribution
        .and_then(|value| value.requested_output_tokens)
        .filter(|value| *value != 0.0 && !value.is_nan())
    {
        generation.insert("maxOutputTokens".into(), output.into());
    }
    if !generation.is_empty() {
        body.insert("generationConfig".into(), Value::Object(generation));
    }
    body.insert(
        "contents".into(),
        json!([{"role":"user","parts":[{"text":prompt}]}]),
    );
    Value::Object(body)
}

pub(super) fn chat(
    request: &ProviderPromptRequest<'_>,
    config: &ProviderRequestConfig,
    prompt: &str,
    reasoning: Option<ReasoningEffort>,
) -> Result<Value, ModelRoundError> {
    let provider = config.metadata.provider_id.as_str();
    let mut instructions = request.instructions.map(str::to_owned);
    let mut response_format = request.response_format.as_ref().map(schema_value);
    if matches!(provider, "zai" | "zai-api")
        && let Some(schema) = &request.response_format
    {
        let schema_json =
            crate::json::stringify(&Value::Object(schema.schema.clone())).map_err(|error| {
                super::invocation("prompt_schema_serialization_failed", error.to_string())
            })?;
        instructions = Some(format!(
            "{}\n\nReturn exactly one JSON object matching the following JSON Schema. Do not wrap it in Markdown or add explanatory text.\n{schema_json}",
            request
                .instructions
                .map(crate::public_text::trim_js_whitespace)
                .unwrap_or_default()
        ));
        response_format = Some(json!({"type":"json_object"}));
    }
    let mut messages = Vec::new();
    if let Some(instructions) = instructions
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        messages.push(json!({"role":"system","content":instructions}));
    }
    messages.push(json!({"role":"user","content":prompt}));
    let mut body = Map::new();
    if !matches!(provider, "kimi" | "qwen") {
        body.insert("temperature".into(), 0.into());
    }
    body.insert("model".into(), config.wire_model.clone().into());
    let attributed_output = request
        .usage_attribution
        .and_then(|value| value.requested_output_tokens)
        .filter(|value| *value != 0.0 && !value.is_nan());
    let output = attributed_output.or_else(|| {
        (provider == "local")
            .then_some(config.metadata.max_output_tokens)
            .flatten()
            .filter(|value| value.is_finite() && *value > 0.0)
            .map(f64::trunc)
    });
    if let Some(output) = output {
        body.insert(
            if provider == "kimi" {
                "max_completion_tokens"
            } else {
                "max_tokens"
            }
            .into(),
            output.into(),
        );
    }
    body.insert("messages".into(), Value::Array(messages));
    body.insert("stream".into(), (provider != "local").into());
    match (provider, reasoning) {
        ("zai" | "zai-api" | "xai" | "opencode-go", Some(reasoning))
            if reasoning != ReasoningEffort::None
                && (provider != "opencode-go" || config.wire_model == "glm-5.3") =>
        {
            body.insert("reasoning_effort".into(), super::effort(reasoning).into());
        }
        ("qwen", Some(reasoning)) => {
            body.insert(
                "enable_thinking".into(),
                (reasoning != ReasoningEffort::None).into(),
            );
        }
        ("kimi", Some(reasoning))
            if config.wire_model == "kimi-k3" && reasoning != ReasoningEffort::None =>
        {
            body.insert("reasoning_effort".into(), super::effort(reasoning).into());
        }
        ("kimi", Some(reasoning)) => {
            body.insert(
                "thinking".into(),
                json!({"type":if reasoning == ReasoningEffort::None {"disabled"} else {"enabled"}}),
            );
        }
        ("local", value) => local_reasoning(&mut body, config, value)?,
        _ => {}
    }
    if let Some(format) = response_format {
        body.insert("response_format".into(), format);
    }
    Ok(Value::Object(body))
}

fn local_reasoning(
    body: &mut Map<String, Value>,
    config: &ProviderRequestConfig,
    reasoning: Option<ReasoningEffort>,
) -> Result<(), ModelRoundError> {
    let native = config.metadata.local_reasoning_budget_ratio.is_none()
        && config
            .metadata
            .reasoning_efforts
            .iter()
            .any(|value| *value != ReasoningEffort::None);
    if native {
        let Some(reasoning) = reasoning else {
            return Ok(());
        };
        if !config.metadata.reasoning_efforts.contains(&reasoning) {
            return Err(super::invocation(
                "unsupported_local_reasoning_effort",
                format!(
                    "Unsupported local reasoning effort: {}",
                    super::effort(reasoning)
                ),
            ));
        }
        body.insert("reasoning_effort".into(), super::effort(reasoning).into());
    } else if config.metadata.platform == Some(crate::models::LocalModelPlatform::LlamaCpp)
        && let (Some(ratio), Some(max)) = (
            config.metadata.local_reasoning_budget_ratio,
            config.metadata.max_output_tokens,
        )
        && ratio.is_finite()
        && ratio > 0.0
        && max.is_finite()
        && max.trunc() > 0.0
    {
        let budget = (max.trunc() * ratio.min(1.0)).round();
        if budget > 0.0 {
            body.insert("thinking_budget_tokens".into(), budget.into());
        }
    }
    Ok(())
}

fn schema_value(schema: &crate::models::PromptJsonSchema<'_>) -> Value {
    let mut value = Map::new();
    value.insert("name".into(), schema.name.into());
    value.insert("schema".into(), Value::Object(schema.schema.clone()));
    if let Some(strict) = schema.strict {
        value.insert("strict".into(), strict.into());
    }
    json!({"type":"json_schema","json_schema":value})
}
