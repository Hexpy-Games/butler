//! Incremental UTC slot indexes. Only partial boundary slots visit raw rows.
use super::{
    buckets::{Buckets, PriceLookup, Tokens},
    row::{Names, UsageRow},
};
use crate::operations::log_tail::LogTail;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::Arc,
};

pub(super) const SLOT_MS: i64 = 900_000;
const TOP_SESSIONS_LIMIT: usize = 200;
#[derive(Clone, Copy, Default)]
pub(super) struct Window<'a> {
    pub(super) scope: Option<&'a str>,
    pub(super) since_ts: Option<f64>,
    pub(super) until_ts: Option<f64>,
}
#[derive(Default)]
struct Slot {
    buckets: Option<Buckets>,
    tokens: Tokens,
    rows: Vec<Arc<UsageRow>>,
    scopes: HashMap<Arc<str>, SessionUsage>,
}
#[derive(Default)]
struct SessionUsage {
    tokens: Tokens,
    last: Option<f64>,
}
impl SessionUsage {
    fn add(&mut self, row: &UsageRow) {
        self.tokens.add(row);
        self.last = Some(self.last.map_or(row.ts, |ts| ts.max(row.ts)));
    }
    fn merge(&mut self, other: &Self) {
        self.tokens.merge(&other.tokens);
        self.last = match (self.last, other.last) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
    }
}
impl Slot {
    fn add(&mut self, row: Arc<UsageRow>, pricing: Option<PriceLookup<'_>>) {
        self.buckets
            .get_or_insert_with(|| Buckets::new(pricing.is_some()))
            .add(&row, pricing);
        self.tokens.add(&row);
        let scope = self.scopes.entry(row.scope.clone()).or_default();
        scope.add(&row);
        self.rows.push(row);
    }
    fn complete(&self, start: i64, window: Window<'_>) -> bool {
        window.since_ts.is_none_or(|ts| ts <= start as f64)
            && window
                .until_ts
                .is_none_or(|ts| ts >= start.saturating_add(SLOT_MS) as f64)
    }
}
#[derive(Default)]
pub(crate) struct UsageLogIndex {
    tail: LogTail,
    names: Names,
    slots: BTreeMap<i64, Slot>,
    by_scope: HashMap<Arc<str>, BTreeMap<i64, Slot>>,
    all: Option<Buckets>,
}
impl UsageLogIndex {
    pub(super) fn refresh(&mut self, data_root: &Path, pricing: Option<PriceLookup<'_>>) {
        let mut tail = std::mem::take(&mut self.tail);
        tail.advance(
            &data_root.join("metrics/prompt-cache-usage.jsonl"),
            self,
            |index| {
                index.slots.clear();
                index.by_scope.clear();
                index.all = None;
                index.names = Names::default();
            },
            |index, line| index.push_line(line, pricing),
        );
        self.tail = tail;
    }
    fn push_line(&mut self, line: &[u8], pricing: Option<PriceLookup<'_>>) {
        let Ok(event) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        let Some(row) = UsageRow::parse(&event, &mut self.names) else {
            return;
        };
        let start = slot_start(row.ts);
        let row = Arc::new(row);
        self.all
            .get_or_insert_with(|| Buckets::new(pricing.is_some()))
            .add(&row, pricing);
        self.by_scope
            .entry(row.scope.clone())
            .or_default()
            .entry(start)
            .or_default()
            .add(row.clone(), pricing);
        self.slots.entry(start).or_default().add(row, pricing);
    }
    pub(super) fn resolve_scope(
        &self,
        session: Option<&str>,
        scope: Option<&str>,
    ) -> Option<String> {
        if let Some(scope) = scope {
            if self.by_scope.contains_key(scope) {
                return Some(scope.into());
            }
            let guided = format!("btcc-guided:{scope}");
            if self.by_scope.contains_key(guided.as_str()) {
                return Some(guided);
            }
        }
        session.map(|id| {
            if self.by_scope.contains_key(id) {
                id.into()
            } else {
                format!("btcc-guided:{id}")
            }
        })
    }
    fn slots(&self, window: Window<'_>) -> impl Iterator<Item = (&i64, &Slot)> {
        let slots = match window.scope {
            Some(scope) => self.by_scope.get(scope),
            None => Some(&self.slots),
        };
        let start = window.since_ts.map_or(i64::MIN, slot_start);
        let end = window.until_ts.map_or(i64::MAX, slot_start);
        slots
            .into_iter()
            .flat_map(move |slots| slots.range(start..=end))
    }
    pub(super) fn buckets(&self, window: Window<'_>, pricing: Option<PriceLookup<'_>>) -> Buckets {
        if window.scope.is_none() && window.since_ts.is_none() && window.until_ts.is_none() {
            return self
                .all
                .clone()
                .unwrap_or_else(|| Buckets::new(pricing.is_some()));
        }
        let mut buckets = Buckets::new(pricing.is_some());
        for (&start, slot) in self.slots(window) {
            if slot.complete(start, window) {
                if let Some(value) = &slot.buckets {
                    buckets.merge(value);
                }
            } else {
                for row in slot.rows.iter().filter(|row| matches(row, window)) {
                    buckets.add(row, pricing);
                }
            }
        }
        buckets
    }
    pub(super) fn tokens(&self, window: Window<'_>) -> Tokens {
        let mut tokens = Tokens::default();
        for (&start, slot) in self.slots(window) {
            if slot.complete(start, window) {
                tokens.merge(&slot.tokens);
            } else {
                for row in slot.rows.iter().filter(|row| matches(row, window)) {
                    tokens.add(row);
                }
            }
        }
        tokens
    }
    pub(super) fn timeline(&self, window: Window<'_>) -> Value {
        let mut slots = Vec::new();
        for (&start, slot) in self.slots(window) {
            let tokens = if slot.complete(start, window) {
                slot.tokens.clone()
            } else {
                let mut tokens = Tokens::default();
                for row in slot.rows.iter().filter(|row| matches(row, window)) {
                    tokens.add(row);
                }
                tokens
            };
            if tokens.request_count > 0 {
                slots.push(json!([
                    start,
                    tokens.request_count,
                    tokens.prompt,
                    tokens.cached,
                    tokens.output
                ]));
            }
        }
        json!({"slotMinutes":15,"slots":slots})
    }
    pub(super) fn top_sessions(&self, window: Window<'_>) -> Value {
        // The selector remains global when the chart is filtered to a session.
        let global = Window {
            scope: None,
            ..window
        };
        let mut scopes = HashMap::<Arc<str>, SessionUsage>::new();
        for (&start, slot) in self.slots(global) {
            if slot.complete(start, global) {
                for (scope, usage) in &slot.scopes {
                    scopes.entry(scope.clone()).or_default().merge(usage);
                }
            } else {
                for row in slot.rows.iter().filter(|row| matches(row, global)) {
                    scopes.entry(row.scope.clone()).or_default().add(row);
                }
            }
        }
        if let Some(scope) = window.scope {
            scopes.entry(Arc::from(scope)).or_default();
        }
        let mut scopes: Vec<_> = scopes.into_iter().collect();
        scopes.sort_by(|a, b| {
            b.1.tokens
                .total
                .total_cmp(&a.1.tokens.total)
                .then_with(|| a.0.cmp(&b.0))
        });
        let selected = window
            .scope
            .and_then(|scope| scopes.iter().position(|item| item.0.as_ref() == scope));
        let mut keep: Vec<_> = (0..scopes.len().min(TOP_SESSIONS_LIMIT)).collect();
        if let Some(index) = selected.filter(|index| *index >= TOP_SESSIONS_LIMIT) {
            keep.push(index);
        }
        json!(
            keep.into_iter()
                .map(|index| {
                    let (scope, usage) = &scopes[index];
                    let tokens = &usage.tokens;
                    let session = scope.strip_prefix("btcc-guided:");
                    json!({"sessionId":session.unwrap_or(scope),"title":null,
                "kind":"butler",
                "totalTokens":tokens.total,"requests":tokens.request_count,"lastUsedMs":usage.last})
                })
                .collect::<Vec<_>>()
        )
    }
}
fn matches(row: &UsageRow, window: Window<'_>) -> bool {
    window.since_ts.is_none_or(|ts| row.ts >= ts) && window.until_ts.is_none_or(|ts| row.ts < ts)
}

pub(super) fn slot_start(ts: f64) -> i64 {
    let slot = (ts / SLOT_MS as f64)
        .floor()
        .clamp((i64::MIN / SLOT_MS) as f64, (i64::MAX / SLOT_MS) as f64);
    butler_core::json::saturating_i64(slot) * SLOT_MS
}
