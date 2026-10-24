//! One provider request of the prompt-usage log, kept compactly in memory.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::Value;

use super::super::stream::number;
use crate::operations::UsageEvent;

/// A prompt section's size in one request.
pub(super) struct SectionRow {
    pub(super) chars: f64,
    pub(super) estimated_tokens: f64,
}

/// The fields of a `metrics/prompt-cache-usage.jsonl` row the monitor reports.
pub(super) struct UsageRow {
    pub(super) ts: f64,
    pub(super) turn_id: Option<Arc<str>>,
    /// The row's whole-millisecond time; rows without one are not priced.
    ts_ms: Option<i64>,
    pub(super) model: Arc<str>,
    pub(super) auth_mode: Option<Arc<str>>,
    pub(super) billing_account: Option<Arc<str>>,
    pub(super) scope: Arc<str>,
    pub(super) root_session_id: Option<Arc<str>>,
    pub(super) role: Option<Arc<str>>,
    pub(super) phase: Option<Arc<str>>,
    pub(super) prompt: f64,
    pub(super) cached: f64,
    pub(super) total: Option<f64>,
    pub(super) reasoning: Option<f64>,
    cache_write: Option<f64>,
    cache_write_1h: Option<f64>,
    pub(super) has_cache_key: bool,
    pub(super) has_retention: bool,
    pub(super) section_layout: usize,
    pub(super) sections: Box<[SectionRow]>,
}

/// Shares one allocation between equal turn ids, models, scopes, phases and section names.
#[derive(Default)]
pub(super) struct Names {
    strings: HashSet<Arc<str>>,
    section_ids: HashMap<Arc<str>, usize>,
    sections: Vec<Arc<str>>,
    layouts: HashMap<Arc<[usize]>, usize>,
    layout_ids: Vec<Arc<[usize]>>,
}
impl Names {
    fn get(&mut self, name: &str) -> Arc<str> {
        if let Some(shared) = self.strings.get(name) {
            return shared.clone();
        }
        let shared: Arc<str> = Arc::from(name);
        self.strings.insert(shared.clone());
        shared
    }
    fn section_id(&mut self, name: &str) -> usize {
        if let Some(id) = self.section_ids.get(name) {
            return *id;
        }
        let name = self.get(name);
        let id = self.sections.len();
        self.sections.push(name.clone());
        self.section_ids.insert(name, id);
        id
    }
    fn layout(&mut self, ids: Vec<usize>) -> usize {
        if let Some(id) = self.layouts.get(ids.as_slice()) {
            return *id;
        }
        let id = self.layout_ids.len();
        let ids: Arc<[usize]> = ids.into();
        self.layout_ids.push(ids.clone());
        self.layouts.insert(ids, id);
        id
    }
    pub(super) fn section(&self, layout: usize, index: usize) -> &Arc<str> {
        &self.sections[self.layout_ids[layout][index]]
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
        let (section_layout, sections) = sections(event, names);
        Some(Self {
            ts,
            turn_id: event
                .get("turnId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(|id| names.get(id)),
            ts_ms: event.get("ts").and_then(Value::as_i64),
            model: names.get(model),
            auth_mode: event["authMode"].as_str().map(|s| names.get(s)),
            billing_account: event["billingAccount"].as_str().map(|s| names.get(s)),
            scope: names.get(scope),
            root_session_id: event
                .get("rootSessionId")
                .and_then(Value::as_str)
                .map(|v| names.get(v)),
            role: event
                .get("role")
                .and_then(Value::as_str)
                .map(|v| names.get(v)),
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
            section_layout,
            sections,
        })
    }

    /// The row as the cost estimate reads it.
    pub(super) fn cost_event(&self) -> Option<UsageEvent> {
        Some(UsageEvent {
            ts: self.ts_ms?,
            model: self.model.to_string(),
            scope: self.scope.to_string(),
            root_session_id: None,
            role: None,
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

fn sections(event: &Value, names: &mut Names) -> (usize, Box<[SectionRow]>) {
    let Some(sections) = event.get("promptSections").and_then(Value::as_array) else {
        return (0, Box::default());
    };
    let mut ids = Vec::new();
    let mut values = Vec::new();
    for section in sections {
        let Some(id) = section
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
        else {
            continue;
        };
        ids.push(names.section_id(id));
        values.push(SectionRow {
            chars: number(section.get("chars")).unwrap_or(0.0).max(0.0),
            estimated_tokens: number(section.get("estimatedTokens"))
                .unwrap_or(0.0)
                .max(0.0),
        });
    }
    (names.layout(ids), values.into_boxed_slice())
}

/// Append-only row storage without a whole-log realloc or power-of-two slack.
/// Stable numeric indices are shared by the global and per-scope slot indexes.
#[derive(Default)]
pub(super) struct Rows {
    chunks: Vec<Vec<UsageRow>>,
    len: usize,
}
const ROWS_PER_CHUNK: usize = 1024;
impl Rows {
    pub(super) fn len(&self) -> usize {
        self.len
    }
    pub(super) fn clear(&mut self) {
        self.chunks.clear();
        self.len = 0;
    }
    pub(super) fn push(&mut self, row: UsageRow) {
        let chunk = self.len / ROWS_PER_CHUNK;
        if chunk == self.chunks.len() {
            self.chunks.push(Vec::with_capacity(ROWS_PER_CHUNK));
        }
        self.chunks[chunk].push(row);
        self.len += 1;
    }
    pub(super) fn get(&self, index: usize) -> Option<&UsageRow> {
        self.chunks
            .get(index / ROWS_PER_CHUNK)?
            .get(index % ROWS_PER_CHUNK)
    }
}
