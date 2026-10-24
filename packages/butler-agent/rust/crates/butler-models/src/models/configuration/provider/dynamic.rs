//! Configured OpenAI model and reasoning preferences.

use serde_json::Value;

use crate::models::{ModelConfigurationEnvironment, ParsedModelRefSource, parse_model_ref};

pub(super) fn configured_model(
    environment: &ModelConfigurationEnvironment,
    config: &Value,
) -> Option<String> {
    if let Some(model) = environment
        .openai_model
        .as_deref()
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        return Some(model.to_owned());
    }
    if let Some(model) = config
        .pointer("/system/openaiModel")
        .and_then(Value::as_str)
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        return Some(model.to_owned());
    }
    let legacy = config
        .pointer("/system/workerModel")
        .filter(|value| !value.is_null())
        .or_else(|| config.pointer("/system/defaultModel"));
    if let Some(model) = legacy
        .and_then(Value::as_str)
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        let parsed = parse_model_ref(model);
        return Some(
            if parsed.source == ParsedModelRefSource::Namespaced && parsed.provider_id == "openai" {
                parsed.model_id
            } else {
                model.to_owned()
            },
        );
    }
    None
}

pub(super) fn configured_reasoning(
    environment: &ModelConfigurationEnvironment,
    config: &Value,
) -> crate::models::ReasoningEffort {
    environment
        .openai_reasoning_effort
        .as_deref()
        .and_then(reasoning)
        .or_else(|| {
            config
                .pointer("/system/openaiReasoningEffort")
                .and_then(Value::as_str)
                .and_then(reasoning)
        })
        .unwrap_or(crate::models::ReasoningEffort::Medium)
}

fn reasoning(value: &str) -> Option<crate::models::ReasoningEffort> {
    use crate::models::ReasoningEffort;
    match value {
        "none" => Some(ReasoningEffort::None),
        "low" => Some(ReasoningEffort::Low),
        "medium" => Some(ReasoningEffort::Medium),
        "high" => Some(ReasoningEffort::High),
        "xhigh" => Some(ReasoningEffort::Xhigh),
        "max" => Some(ReasoningEffort::Max),
        _ => None,
    }
}
