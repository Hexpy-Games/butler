use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Serialize, Serializer};

use crate::btcc::ModelRoundError;
use crate::models::{
    PromptCacheRetention, PromptUsageBudgetState, PromptUsageMetricInput,
    PromptUsageSectionAttribution, ReasoningEffort,
};

pub(super) fn line(
    input: &PromptUsageMetricInput<'_>,
    timestamp: i64,
    prompt_tokens: f64,
    budget: Option<&PromptUsageBudgetState>,
) -> Result<String, ModelRoundError> {
    let attribution = input.usage_attribution;
    let event = Event {
        ts: timestamp,
        model: input.model,
        scope: input.scope,
        turn_id: attribution.and_then(|value| value.turn_id),
        phase: attribution.and_then(|value| value.phase),
        round_index: attribution.and_then(|value| value.round_index),
        reasoning_effort: attribution.and_then(|value| value.reasoning_effort),
        prompt_tokens: prompt_tokens.max(0.0),
        cached_tokens: input.cached_tokens.max(0.0),
        cache_write_tokens: input.cache_write_tokens.flatten().map(|value| {
            // JS Math.max preserves NaN; JSON.stringify then emits null.
            if value.is_nan() {
                value
            } else {
                value.max(0.0)
            }
        }),
        total_tokens: input.total_tokens,
        prompt_cache_key: input.prompt_cache_key,
        prompt_cache_retention: input
            .prompt_cache_retention
            .map(|retention| match retention {
                PromptCacheRetention::InMemory => "in_memory",
                PromptCacheRetention::Hours24 => "24h",
            }),
        budget_state: budget.map(Budget),
        prompt_sections: attribution
            .and_then(|value| value.prompt_sections)
            .map(Sections),
    };
    // Only this small metadata event is materialized; prompts, attachments and
    // callbacks never enter the encoder or survive the append operation.
    let value = serde_json::to_value(event).map_err(encode_failure)?;
    crate::json::stringify(&value).map_err(encode_failure)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Event<'a> {
    ts: i64,
    model: &'a str,
    scope: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    round_index: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<&'a ReasoningEffort>,
    prompt_tokens: f64,
    cached_tokens: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_write_tokens: Option<f64>,
    total_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_cache_key: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_cache_retention: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    budget_state: Option<Budget<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_sections: Option<Sections<'a>>,
}

struct Budget<'a>(&'a PromptUsageBudgetState);

impl Serialize for Budget<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = self.0;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("status", &value.status)?;
        map.serialize_entry("requestCount", &value.request_count)?;
        map.serialize_entry("maxRequests", &value.max_requests)?;
        for (key, field) in [
            ("promptTokens", value.prompt_tokens),
            ("cachedTokens", value.cached_tokens),
            ("outputTokens", value.output_tokens),
            ("totalTokens", value.total_tokens),
            ("maxPromptTokens", value.max_prompt_tokens),
            ("maxOutputTokens", value.max_output_tokens),
            ("maxTotalTokens", value.max_total_tokens),
            ("cumulativeRequestCount", value.cumulative_request_count),
            ("cumulativePromptTokens", value.cumulative_prompt_tokens),
            ("cumulativeCachedTokens", value.cumulative_cached_tokens),
            ("cumulativeOutputTokens", value.cumulative_output_tokens),
            ("cumulativeTotalTokens", value.cumulative_total_tokens),
        ] {
            if let Some(field) = field {
                map.serialize_entry(key, &field)?;
            }
        }
        if let Some(reason) = &value.stop_reason {
            map.serialize_entry("stopReason", reason)?;
        }
        map.end()
    }
}

struct Sections<'a>(&'a [PromptUsageSectionAttribution]);

impl Serialize for Sections<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for section in self.0 {
            sequence.serialize_element(&Section {
                id: &section.id,
                chars: section.chars,
                estimated_tokens: section.estimated_tokens,
            })?;
        }
        sequence.end()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Section<'a> {
    id: &'a str,
    chars: f64,
    estimated_tokens: f64,
}

fn encode_failure(error: impl std::fmt::Display) -> ModelRoundError {
    ModelRoundError::InvocationFailure {
        code: None,
        message: error.to_string(),
    }
}
