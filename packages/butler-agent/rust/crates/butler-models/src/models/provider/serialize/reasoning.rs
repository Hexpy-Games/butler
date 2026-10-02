use serde_json::{Map, Value};

use crate::models::{LocalModelPlatform, ModelProviderMetadata, ReasoningEffort};
use butler_turn::btcc::{ModelRoundError, ModelRoundRequest, RuntimeFailure};

pub(super) fn effort(request: &ModelRoundRequest<'_>) -> Option<&'static str> {
    match request.reasoning_effort {
        butler_turn::btcc::ReasoningEffort::None => None,
        butler_turn::btcc::ReasoningEffort::Low => Some("low"),
        butler_turn::btcc::ReasoningEffort::Medium => Some("medium"),
        butler_turn::btcc::ReasoningEffort::High => Some("high"),
        butler_turn::btcc::ReasoningEffort::Xhigh => Some("xhigh"),
        butler_turn::btcc::ReasoningEffort::Max => Some("max"),
    }
}

pub(super) fn gemini_level(value: &butler_turn::btcc::ReasoningEffort) -> &'static str {
    match value {
        butler_turn::btcc::ReasoningEffort::None => "MINIMAL",
        butler_turn::btcc::ReasoningEffort::Low => "LOW",
        butler_turn::btcc::ReasoningEffort::Medium => "MEDIUM",
        butler_turn::btcc::ReasoningEffort::High
        | butler_turn::btcc::ReasoningEffort::Xhigh
        | butler_turn::btcc::ReasoningEffort::Max => "HIGH",
    }
}

pub(super) fn anthropic(
    model: &str,
    request: &ModelRoundRequest<'_>,
) -> Option<Map<String, Value>> {
    let effort = effort(request);
    let mut output = Map::new();
    let claude5 = crate::models::ANTHROPIC_ADAPTIVE_MODELS.iter().any(|base| {
        model == *base
            || model
                .strip_prefix(base)
                .and_then(|suffix| suffix.strip_prefix('-'))
                .is_some_and(|version| {
                    !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit())
                })
    });
    if claude5 {
        output.insert("thinking".into(), serde_json::json!({"type":"adaptive"}));
        if let Some(effort) = effort {
            output.insert("output_config".into(), serde_json::json!({"effort":effort}));
        }
    } else if model == crate::models::ANTHROPIC_BUDGET_MODEL {
        output.insert(
            "thinking".into(),
            effort.map_or_else(
                || serde_json::json!({"type":"disabled"}),
                |effort| serde_json::json!({"type":"enabled","budget_tokens":budget(effort)}),
            ),
        );
    }
    (!output.is_empty()).then_some(output)
}

pub(super) fn local(
    metadata: &ModelProviderMetadata,
    request: &ModelRoundRequest<'_>,
) -> Result<Map<String, Value>, ModelRoundError> {
    let mut output = Map::new();
    let effort = btcc_effort_name(request.reasoning_effort);
    let native = metadata.local_reasoning_budget_ratio.is_none()
        && metadata
            .reasoning_efforts
            .iter()
            .any(|value| *value != ReasoningEffort::None);
    if native {
        if !metadata
            .reasoning_efforts
            .iter()
            .any(|value| catalog_effort_name(*value) == effort)
        {
            return Err(ModelRoundError::Operational(RuntimeFailure {
                code: "gateway_failed".into(),
                retryable: true,
            }));
        }
        output.insert("reasoning_effort".into(), effort.into());
        return Ok(output);
    }
    if metadata.platform == Some(LocalModelPlatform::LlamaCpp)
        && let (Some(ratio), Some(max)) = (
            metadata.local_reasoning_budget_ratio,
            metadata.max_output_tokens,
        )
        && ratio.is_finite()
        && ratio > 0.0
        && max.is_finite()
        && max.trunc() > 0.0
    {
        let budget = (max.trunc() * ratio.min(1.0)).round();
        if budget > 0.0 {
            output.insert("thinking_budget_tokens".into(), budget.into());
        }
    }
    Ok(output)
}

fn budget(value: &str) -> u64 {
    match value {
        "low" => 1024,
        "medium" => 4096,
        "high" => 8192,
        "xhigh" => 16384,
        "max" => 32768,
        _ => 0,
    }
}

fn btcc_effort_name(value: &butler_turn::btcc::ReasoningEffort) -> &'static str {
    match value {
        butler_turn::btcc::ReasoningEffort::None => "none",
        butler_turn::btcc::ReasoningEffort::Low => "low",
        butler_turn::btcc::ReasoningEffort::Medium => "medium",
        butler_turn::btcc::ReasoningEffort::High => "high",
        butler_turn::btcc::ReasoningEffort::Xhigh => "xhigh",
        butler_turn::btcc::ReasoningEffort::Max => "max",
    }
}

fn catalog_effort_name(value: ReasoningEffort) -> &'static str {
    match value {
        ReasoningEffort::None => "none",
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::Xhigh => "xhigh",
        ReasoningEffort::Max => "max",
    }
}
