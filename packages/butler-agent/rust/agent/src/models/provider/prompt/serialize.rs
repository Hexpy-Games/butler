use serde_json::{Map, Value, json};

use crate::{
    btcc::ModelRoundError,
    models::{PromptCacheRetention, ProviderPromptRequest, ProviderRequestConfig, ReasoningEffort},
};

use super::super::{ProviderAuthMode, serialize::Carrier};

mod compatible;

pub(super) struct PromptWire {
    pub body: Value,
    pub cache_key: Option<String>,
    pub cache_retention: Option<PromptCacheRetention>,
}

pub(super) fn body(
    request: &ProviderPromptRequest<'_>,
    config: &ProviderRequestConfig,
    carrier: Carrier,
) -> Result<PromptWire, ModelRoundError> {
    let reasoning = request
        .reasoning_effort
        .copied()
        .or(config.prompt_reasoning_effort);
    let prompt = super::attachments::prompt(request)?;
    let (body, cache_key, cache_retention) = match carrier {
        Carrier::Responses if config.metadata.provider_id == "openai" => responses(
            request,
            config,
            &prompt,
            reasoning.unwrap_or(config.metadata.default_reasoning_effort),
        )?,
        Carrier::Responses => (
            hosted_responses(request, config, &prompt, reasoning),
            None,
            None,
        ),
        Carrier::Anthropic => (
            compatible::anthropic(request, config, &prompt, reasoning),
            None,
            None,
        ),
        Carrier::Gemini => (
            compatible::gemini(request, config, &prompt, reasoning),
            None,
            None,
        ),
        Carrier::Chat { .. } => (
            compatible::chat(request, config, &prompt, reasoning)?,
            None,
            None,
        ),
    };
    Ok(PromptWire {
        body,
        cache_key,
        cache_retention,
    })
}

fn hosted_responses(
    request: &ProviderPromptRequest<'_>,
    config: &ProviderRequestConfig,
    prompt: &str,
    reasoning: Option<ReasoningEffort>,
) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), config.wire_model.clone().into());
    if let Some(instructions) = request
        .instructions
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        body.insert("instructions".into(), instructions.into());
    }
    body.insert("input".into(), prompt.into());
    if let Some(reasoning) = reasoning.filter(|value| *value != ReasoningEffort::None) {
        body.insert("reasoning".into(), json!({"effort":effort(reasoning)}));
    }
    if let Some(schema) = &request.response_format {
        let mut format = Map::new();
        format.insert("type".into(), "json_schema".into());
        format.insert("name".into(), schema.name.into());
        format.insert("schema".into(), Value::Object(schema.schema.clone()));
        if let Some(strict) = schema.strict {
            format.insert("strict".into(), strict.into());
        }
        body.insert("text".into(), json!({"format":format}));
    }
    Value::Object(body)
}

fn responses(
    request: &ProviderPromptRequest<'_>,
    config: &ProviderRequestConfig,
    prompt: &str,
    reasoning: ReasoningEffort,
) -> Result<(Value, Option<String>, Option<PromptCacheRetention>), ModelRoundError> {
    let codex = matches!(
        config.auth.mode(),
        ProviderAuthMode::CodexOauth | ProviderAuthMode::CodexSubscription
    );
    let scope = request.cache_scope.unwrap_or("text-prompt");
    let key = config.prompt_cache.key_prefix.as_deref().map(|prefix| {
        if scope.is_empty() {
            prefix.to_owned()
        } else {
            format!("{prefix}:{scope}")
        }
    });
    let explicit = request.cache_boundary.is_some()
        && !codex
        && matches!(
            config.wire_model.as_str(),
            "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna"
        );
    let input = if let Some(boundary) = &request.cache_boundary {
        if request.prompt != format!("{}{}", boundary.stable_prefix, boundary.dynamic_suffix) {
            return Err(invocation(
                "openai_prompt_cache_boundary_invalid",
                "OpenAI prompt cache boundary does not reconstruct the exact prompt.",
            ));
        }
        if !codex && !explicit {
            Value::String(prompt.into())
        } else {
            let mut stable = json!({"type":"input_text","text":boundary.stable_prefix});
            if explicit {
                stable
                    .as_object_mut()
                    .unwrap()
                    .insert("prompt_cache_breakpoint".into(), json!({"mode":"explicit"}));
            }
            json!([{"role":"user","content":[
                stable,
                {"type":"input_text","text":prompt.replacen(request.prompt, boundary.dynamic_suffix, 1)}
            ]}])
        }
    } else if codex {
        json!([{"role":"user","content":[{"type":"input_text","text":prompt}]}])
    } else {
        Value::String(prompt.into())
    };
    let mut body = Map::new();
    if let Some(output) = request
        .usage_attribution
        .and_then(|value| value.requested_output_tokens)
    {
        body.insert("max_output_tokens".into(), output.into());
    }
    body.insert("model".into(), config.wire_model.clone().into());
    body.insert("store".into(), true.into());
    if let Some(key) = &key {
        body.insert("prompt_cache_key".into(), key.clone().into());
    }
    if !codex && let Some(retention) = config.prompt_cache.retention {
        body.insert(
            "prompt_cache_retention".into(),
            retention_text(retention).into(),
        );
    }
    if explicit {
        body.insert("prompt_cache_options".into(), json!({"mode":"explicit"}));
    }
    if let Some(instructions) = request.instructions {
        body.insert("instructions".into(), instructions.into());
    }
    if let Some(schema) = &request.response_format {
        let mut format = Map::new();
        format.insert("type".into(), "json_schema".into());
        format.insert("name".into(), schema.name.into());
        format.insert("schema".into(), Value::Object(schema.schema.clone()));
        if let Some(strict) = schema.strict {
            format.insert("strict".into(), strict.into());
        }
        body.insert("text".into(), json!({"format":format}));
    }
    if reasoning != ReasoningEffort::None {
        body.insert("reasoning".into(), json!({"effort":effort(reasoning)}));
    }
    body.insert("input".into(), input);
    if codex {
        let model = config
            .wire_model
            .strip_suffix("-codex")
            .unwrap_or(&config.wire_model)
            .to_owned();
        body.insert("model".into(), model.into());
        let instructions = request
            .instructions
            .map(crate::public_text::trim_js_whitespace)
            .filter(|value| !value.is_empty())
            .unwrap_or("You are Butler, a helpful personal AI assistant.");
        body.insert("instructions".into(), instructions.into());
        body.insert("store".into(), false.into());
        body.insert("stream".into(), true.into());
        body.entry("text")
            .or_insert_with(|| json!({"verbosity":"medium"}));
        body.shift_remove("prompt_cache_retention");
    }
    Ok((
        Value::Object(body),
        key,
        if codex || explicit {
            None
        } else {
            config.prompt_cache.retention
        },
    ))
}

fn effort(value: ReasoningEffort) -> &'static str {
    match value {
        ReasoningEffort::None => "none",
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::Xhigh => "xhigh",
        ReasoningEffort::Max => "max",
    }
}

fn gemini_level(value: ReasoningEffort) -> &'static str {
    match value {
        ReasoningEffort::None => "MINIMAL",
        ReasoningEffort::Low => "LOW",
        ReasoningEffort::Medium => "MEDIUM",
        _ => "HIGH",
    }
}

fn anthropic_budget(value: ReasoningEffort) -> u64 {
    match value {
        ReasoningEffort::Low | ReasoningEffort::None => 1_024,
        ReasoningEffort::Medium => 4_096,
        ReasoningEffort::High => 8_192,
        ReasoningEffort::Xhigh => 16_384,
        ReasoningEffort::Max => 32_768,
    }
}

fn retention_text(value: PromptCacheRetention) -> &'static str {
    match value {
        PromptCacheRetention::InMemory => "in_memory",
        PromptCacheRetention::Hours24 => "24h",
    }
}

fn invocation(code: &str, message: impl Into<String>) -> ModelRoundError {
    ModelRoundError::InvocationFailure {
        code: Some(code.into()),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests;
