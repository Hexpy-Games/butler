//! One agent-loop round's provider usage, appended to the prompt metrics.

use butler_turn::btcc::{ModelRoundError, ModelRoundRequest};
use serde_json::Value;

use super::{ModelProvider, ProviderRequestConfig};
use crate::models::{PromptUsageAttribution, PromptUsageMetricInput};

/// Appends one round's provider-reported usage, with how the request was
/// billed, to the provider's prompt metrics.
pub(super) fn record(
    provider: &ModelProvider,
    request: &ModelRoundRequest<'_>,
    usage: Option<&Value>,
    config: &ProviderRequestConfig,
    prefix: &Value,
) -> Result<(), ModelRoundError> {
    let auth_mode = provider
        .catalog
        .usage_auth_mode(&config.metadata.provider_id, config.auth.mode());
    let number = |key: &str| {
        usage
            .and_then(|usage| usage.get(key))
            .and_then(Value::as_f64)
    };
    let attribution = request
        .usage_attribution
        .map(|value| PromptUsageAttribution {
            turn_id: Some(&value.turn_id),
            phase: Some(&value.phase),
            round_index: value.round_index.map(f64::from),
            reasoning_effort: None,
            requested_output_tokens: request.max_output_tokens,
            budget_state: None,
            budget_state_source: None,
            prompt_sections: None,
        });
    provider.prompt_metrics.append(PromptUsageMetricInput {
        model: usage
            .and_then(|usage| usage.get("model"))
            .and_then(Value::as_str)
            .unwrap_or(request.model),
        scope: request.cache_scope.unwrap_or("btcc-agent-loop"),
        prompt_tokens: number("promptTokens"),
        cached_tokens: number("cachedTokens").unwrap_or(0.0),
        total_tokens: number("totalTokens"),
        cache_write_tokens: number("cacheWriteTokens").map(Some),
        prompt_cache_key: None,
        prompt_cache_retention: None,
        butler_data: request.butler_data,
        usage_attribution: attribution.as_ref(),
        reasoning_tokens: number("reasoningTokens"),
        cache_write_1h_tokens: number("cacheWrite1hTokens"),
        auth_mode: Some(auth_mode),
        prefix_diagnostics: Some(prefix),
    })
}
