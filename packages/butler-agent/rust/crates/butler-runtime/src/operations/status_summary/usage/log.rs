//! Incremental UTC slot indexes with compact per-scope counters.
#[path = "sessions.rs"]
mod sessions;
use super::{
    buckets::{Buckets, PriceLookup, Tokens},
    row::{Names, Rows, UsageRow},
};
use crate::operations::log_tail::LogTail;
use serde_json::{Value, json};
use sessions::SessionCache;
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::Arc,
};

pub(super) const SLOT_MS: i64 = 900_000;
#[derive(Clone, Copy, Default)]
pub(super) struct Window<'a> {
    pub(super) scope: Option<&'a str>,
    pub(super) since_ts: Option<f64>,
    pub(super) until_ts: Option<f64>,
}
#[derive(Default)]
struct Slot {
    buckets: Option<Buckets>,
    rows: Vec<u32>,
}
#[derive(Default)]
struct ScopeSlot {
    usage: SessionUsage,
    rows: Vec<u32>,
}
/// Only counters consumed by timeline/topSessions, not full model buckets.
#[derive(Clone, Default)]
struct SessionUsage {
    requests: u64,
    prompt: f64,
    cached: f64,
    output: f64,
    total: f64,
    last: Option<f64>,
}
impl SessionUsage {
    fn add(&mut self, row: &UsageRow) {
        self.requests += 1;
        self.prompt += row.prompt;
        self.cached += row.cached;
        self.total += row.total.unwrap_or_default();
        self.output += row.total.map_or(0.0, |total| (total - row.prompt).max(0.0));
        self.last = Some(self.last.map_or(row.ts, |ts| ts.max(row.ts)));
    }
    fn merge(&mut self, other: &Self) {
        self.requests += other.requests;
        self.prompt += other.prompt;
        self.cached += other.cached;
        self.output += other.output;
        self.total += other.total;
        self.last = match (self.last, other.last) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
    }
    fn tokens(&self) -> Tokens {
        Tokens::timeline(
            self.requests,
            self.prompt,
            self.cached,
            self.output,
            self.total,
        )
    }
}

fn complete(start: i64, window: Window<'_>) -> bool {
    window.since_ts.is_none_or(|ts| ts <= start as f64)
        && window
            .until_ts
            .is_none_or(|ts| ts >= start.saturating_add(SLOT_MS) as f64)
}
#[derive(Default)]
pub(crate) struct UsageLogIndex {
    tail: LogTail,
    names: Names,
    slots: BTreeMap<i64, Slot>,
    by_scope: HashMap<Arc<str>, BTreeMap<i64, ScopeSlot>>,
    rows: Rows,
    all: Option<Buckets>,
    // One range of complete slots; append/rotation invalidates it immediately.
    session_totals: Option<SessionCache>,
}
impl UsageLogIndex {
    pub(super) fn refresh(&mut self, data_root: &Path, pricing: Option<PriceLookup<'_>>) {
        let mut tail = std::mem::take(&mut self.tail);
        tail.advance(
            &data_root.join("metrics/prompt-cache-usage.jsonl"),
            self,
            |index| {
                index.rows.clear();
                index.slots.clear();
                index.by_scope.clear();
                index.all = None;
                index.session_totals = None;
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
        let Ok(index) = u32::try_from(self.rows.len()) else {
            return;
        };
        let start = slot_start(row.ts);
        self.session_totals = None;
        if let Some(all) = &mut self.all {
            all.add(&row, pricing, &self.names);
        }
        let scoped = self
            .by_scope
            .entry(row.scope.clone())
            .or_default()
            .entry(start)
            .or_default();
        scoped.usage.add(&row);
        scoped.rows.push(index);
        let global = self.slots.entry(start).or_default();
        global
            .buckets
            .get_or_insert_with(|| Buckets::new(pricing.is_some()))
            .add(&row, pricing, &self.names);
        global.rows.push(index);
        self.rows.push(row);
    }
    pub(super) fn resolve_scope(
        &self,
        session: Option<&str>,
        scope: Option<&str>,
    ) -> Option<String> {
        if let Some(scope) = scope {
            let guided = format!("btcc-guided:{scope}");
            if self.by_scope.contains_key(guided.as_str()) {
                return Some(guided);
            }
            if self.by_scope.contains_key(scope) {
                return Some(scope.into());
            }
        }
        session.map(|id| {
            let guided = format!("btcc-guided:{id}");
            if self.by_scope.contains_key(guided.as_str()) || !self.by_scope.contains_key(id) {
                guided
            } else {
                id.into()
            }
        })
    }
    fn slots(&self, window: Window<'_>) -> impl Iterator<Item = (&i64, &Slot)> {
        let start = window.since_ts.map_or(i64::MIN, slot_start);
        let end = window.until_ts.map_or(i64::MAX, slot_start);
        self.slots.range(start..=end)
    }
    fn scope_slots<'a>(
        &'a self,
        scope: &str,
        window: Window<'_>,
    ) -> impl Iterator<Item = (&'a i64, &'a ScopeSlot)> {
        let start = window.since_ts.map_or(i64::MIN, slot_start);
        let end = window.until_ts.map_or(i64::MAX, slot_start);
        self.by_scope
            .get(scope)
            .into_iter()
            .flat_map(move |slots| slots.range(start..=end))
    }
    fn matching_rows<'a>(
        &'a self,
        indices: &'a [u32],
        window: Window<'a>,
    ) -> impl Iterator<Item = &'a UsageRow> {
        indices
            .iter()
            .filter_map(|index| self.rows.get(*index as usize))
            .filter(move |row| matches(row, window))
    }
    pub(super) fn buckets(
        &mut self,
        window: Window<'_>,
        pricing: Option<PriceLookup<'_>>,
    ) -> Buckets {
        let all_time =
            window.scope.is_none() && window.since_ts.is_none() && window.until_ts.is_none();
        if all_time && let Some(all) = &self.all {
            return all.clone();
        }
        let mut buckets = Buckets::new(pricing.is_some());
        if let Some(scope) = window.scope {
            for (_, slot) in self.scope_slots(scope, window) {
                for row in self.matching_rows(&slot.rows, window) {
                    buckets.add(row, pricing, &self.names);
                }
            }
            return buckets;
        }
        for (&start, slot) in self.slots(window) {
            if complete(start, window) {
                if let Some(value) = &slot.buckets {
                    buckets.merge(value);
                }
            } else {
                for row in self.matching_rows(&slot.rows, window) {
                    buckets.add(row, pricing, &self.names);
                }
            }
        }
        if all_time {
            self.all = Some(buckets.clone());
        }
        buckets
    }
    fn slot_tokens(
        &self,
        start: i64,
        indices: &[u32],
        totals: &Tokens,
        window: Window<'_>,
    ) -> Tokens {
        if complete(start, window) {
            return totals.clone();
        }
        let mut tokens = Tokens::default();
        for row in self.matching_rows(indices, window) {
            tokens.add(row);
        }
        tokens
    }
    fn token_slots(&self, window: Window<'_>) -> Vec<(i64, Tokens)> {
        if let Some(scope) = window.scope {
            self.scope_slots(scope, window)
                .map(|(&start, slot)| {
                    (
                        start,
                        self.slot_tokens(start, &slot.rows, &slot.usage.tokens(), window),
                    )
                })
                .collect()
        } else {
            self.slots(window)
                .map(|(&start, slot)| {
                    let totals = slot
                        .buckets
                        .as_ref()
                        .map(Buckets::tokens)
                        .cloned()
                        .unwrap_or_default();
                    (start, self.slot_tokens(start, &slot.rows, &totals, window))
                })
                .collect()
        }
    }
    pub(super) fn tokens(&self, window: Window<'_>) -> Tokens {
        let mut tokens = Tokens::default();
        for (_, value) in self.token_slots(window) {
            tokens.merge(&value);
        }
        tokens
    }
    pub(super) fn timeline(&self, window: Window<'_>) -> Value {
        let slots: Vec<_> = self
            .token_slots(window)
            .into_iter()
            .filter(|(_, tokens)| tokens.request_count > 0)
            .map(|(start, tokens)| {
                json!([
                    start,
                    tokens.request_count,
                    tokens.prompt,
                    tokens.cached,
                    tokens.output
                ])
            })
            .collect();
        json!({"slotMinutes":15,"slots":slots})
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
