//! One provider request of the prompt-usage log, kept compactly in memory.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use super::super::stream::number;
use crate::operations::UsageEvent;

/// A prompt section's size in one request.
pub(super) struct SectionRow {
    pub(super) id: Arc<str>,
    pub(super) chars: f64,
    pub(super) estimated_tokens: f64,
}

/// The fields of a `metrics/prompt-cache-usage.jsonl` row the monitor reports.
pub(super) struct UsageRow {
    pub(super) ts: f64,
    /// The row's whole-millisecond time; rows without one are not priced.
    ts_ms: Option<i64>,
    pub(super) model: Arc<str>,
    pub(super) scope: Arc<str>,
    pub(super) phase: Option<Arc<str>>,
    pub(super) prompt: f64,
    pub(super) cached: f64,
    pub(super) total: Option<f64>,
    pub(super) reasoning: Option<f64>,
    cache_write: Option<f64>,
    cache_write_1h: Option<f64>,
    pub(super) has_cache_key: bool,
    pub(super) has_retention: bool,
    pub(super) sections: Box<[SectionRow]>,
}

/// Shares one allocation between equal model, scope, phase and section names.
#[derive(Default)]
pub(super) struct Names(HashMap<Box<str>, Arc<str>>);

impl Names {
    fn get(&mut self, name: &str) -> Arc<str> {
        if let Some(shared) = self.0.get(name) {
            return shared.clone();
        }
        let shared: Arc<str> = Arc::from(name);
        self.0.insert(name.into(), shared.clone());
        shared
    }
}

impl UsageRow {
    /// The row of a valid prompt-usage event: a time, model, scope, and
    /// prompt and cached token counts; `None` for anything else.
    pub(super) fn parse(event: &Value, names: &mut Names) -> Option<Self> {
        let ts = number(event.get("ts"))?;
        let model = event.get("model")?.as_str()?;
        let scope = event.get("scope")?.as_str()?;
        let prompt = number(event.get("promptTokens"))?;
        let cached = number(event.get("cachedTokens"))?;
        let phase = event
            .get("phase")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(|value| names.get(value.trim()));
        Some(Self {
            ts,
            ts_ms: event.get("ts").and_then(Value::as_i64),
            model: names.get(model),
            scope: names.get(scope),
            phase,
            prompt,
            cached,
            total: number(event.get("totalTokens")),
            reasoning: number(event.get("reasoningTokens")),
            cache_write: number(event.get("cacheWriteTokens")),
            cache_write_1h: number(event.get("cacheWrite1hTokens")),
            has_cache_key: event
                .get("promptCacheKey")
                .and_then(Value::as_str)
                .is_some_and(|key| !key.is_empty()),
            has_retention: event
                .get("promptCacheRetention")
                .and_then(Value::as_str)
                .is_some(),
            sections: sections(event, names),
        })
    }

    /// The row as the cost estimate reads it.
    pub(super) fn cost_event(&self) -> Option<UsageEvent> {
        Some(UsageEvent {
            ts: self.ts_ms?,
            model: self.model.to_string(),
            scope: self.scope.to_string(),
            prompt_tokens: self.prompt,
            cached_tokens: self.cached,
            cache_write_tokens: self.cache_write,
            cache_write_1h_tokens: self.cache_write_1h,
            total_tokens: self.total,
            reasoning_tokens: self.reasoning,
            auth_mode: None,
        })
    }
}

fn sections(event: &Value, names: &mut Names) -> Box<[SectionRow]> {
    let Some(sections) = event.get("promptSections").and_then(Value::as_array) else {
        return Box::default();
    };
    sections
        .iter()
        .filter_map(|section| {
            let id = section
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())?;
            Some(SectionRow {
                id: names.get(id),
                chars: number(section.get("chars")).unwrap_or(0.0).max(0.0),
                estimated_tokens: number(section.get("estimatedTokens"))
                    .unwrap_or(0.0)
                    .max(0.0),
            })
        })
        .collect()
}
