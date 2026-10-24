//! Incremental UTC slot indexes with compact per-scope counters.
#[path = "roles.rs"]
mod roles;
#[path = "sessions.rs"]
mod sessions;
use super::{
    buckets::{Buckets, PriceLookup, Tokens},
    row::{Names, Rows, UsageRow},
};
use crate::operations::{UsageScope, log_tail::LogTail};
use serde_json::{Value, json};
use sessions::SessionCache;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
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
    fn tokens(&self) -> Tokens {
        self.tokens.clone()
    }
}

fn complete(start: i64, window: Window<'_>) -> bool {
    window.since_ts.is_none_or(|ts| ts <= start as f64)
        && window
            .until_ts
            .is_none_or(|ts| ts >= start.saturating_add(SLOT_MS) as f64)
}
struct SelectedBuckets {
    scope: String,
    since: Option<f64>,
    until: Option<f64>,
    generation: u64,
    buckets: Buckets,
}
#[derive(Default)]
pub(crate) struct UsageLogIndex {
    pub(super) owners: Arc<crate::operations::UsageOwners>,
    tail: LogTail,
    history: super::history::History,
    pub(super) plan: super::plan::PlanUsageIndex,
    names: Names,
    slots: BTreeMap<i64, Slot>,
    scope_names: HashSet<Arc<str>>,
    by_scope: HashMap<UsageScope, BTreeMap<i64, ScopeSlot>>,
    selected: Option<SelectedBuckets>,
    rows: Rows,
    all: Option<Buckets>,
    // One range of complete slots; append/rotation invalidates it immediately.
    session_totals: Option<SessionCache>,
}
impl UsageLogIndex {
    pub(super) fn with_owners(owners: Arc<crate::operations::UsageOwners>) -> Self {
        Self {
            owners,
            ..Self::default()
        }
    }
    pub(super) fn refresh(&mut self, data_root: &Path, pricing: Option<PriceLookup<'_>>) {
        let mut tail = std::mem::take(&mut self.tail);
        tail.advance(
            &data_root.join("metrics/prompt-cache-usage.jsonl"),
            self,
            |index| {
                index.rows.clear();
                index.history = Default::default();
                index.plan = Default::default();
                index.slots.clear();
                index.by_scope.clear();
                index.scope_names.clear();
                index.all = None;
                index.selected = None;
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
        let key = self.owners.observe(
            &row.scope,
            row.root_session_id.as_deref(),
            row.role.as_deref(),
        );
        self.scope_names.insert(row.scope.clone());
        self.plan.push(&row, chrono::Utc::now().timestamp_millis());
        let start = slot_start(row.ts);
        self.history.push(start, &row);
        self.session_totals = None;
        self.selected = None;
        if let Some(all) = &mut self.all {
            all.add(&row, pricing, &self.names);
        }
        let scoped = self
            .by_scope
            .entry(key)
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
    fn sync_history_zone(&mut self) -> std::io::Result<()> {
        self.history
            .sync_zone(self.slots.iter().map(|(&start, slot)| {
                (
                    start,
                    slot.buckets
                        .as_ref()
                        .into_iter()
                        .flat_map(Buckets::provider_totals)
                        .map(|(id, total)| (id.to_owned(), total))
                        .collect(),
                )
            }))
    }
    pub(super) fn attach_provider_usage(
        &mut self,
        providers: &mut Value,
        sources: Option<&super::UsageMonitorSources<'_>>,
        now: f64,
    ) {
        super::plan::attach(providers, self, sources, now);
        let now = butler_core::json::saturating_i64(now);
        if self.sync_history_zone().is_err() {
            return;
        }
        if let Some(items) = providers["providers"].as_array_mut() {
            for item in items {
                let total = item["providerId"]
                    .as_str()
                    .and_then(|id| self.history.month_tokens(now, id));
                item["monthTokens"] = json!(total);
            }
        }
    }
    pub(super) fn history(&mut self) -> std::io::Result<Value> {
        self.sync_history_zone()?;
        self.history.view(chrono::Utc::now().timestamp_millis())
    }
    pub(super) fn plan_usage(&self, account: &str, now: i64) -> Value {
        self.plan.view(account, now, |start, end| {
            let mut tokens = super::plan::PlanTokens::default();
            if let Some(slot) = self.slots.get(&slot_start(start as f64)) {
                for row in self.matching_rows(
                    &slot.rows,
                    Window {
                        since_ts: Some(start as f64),
                        until_ts: Some(end as f64),
                        scope: None,
                    },
                ) {
                    if super::plan::account(row) == Some(account) {
                        tokens.add(row);
                    }
                }
            }
            tokens
        })
    }
    pub(super) fn resolve_scope(
        &self,
        session: Option<&str>,
        scope: Option<&str>,
    ) -> Option<String> {
        if let Some(scope) = scope {
            let guided = format!("btcc-guided:{scope}");
            if self.scope_names.contains(guided.as_str()) {
                return Some(self.owners.root_scope(&guided));
            }
            if self.scope_names.contains(scope) {
                return Some(self.owners.root_scope(scope));
            }
        }
        session.map(|id| {
            let guided = format!("btcc-guided:{id}");
            if self.scope_names.contains(guided.as_str()) || !self.scope_names.contains(id) {
                self.owners.root_scope(&guided)
            } else {
                self.owners.root_scope(id)
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
        scope: &UsageScope,
        window: Window<'_>,
    ) -> impl Iterator<Item = (&'a i64, &'a ScopeSlot)> + use<'a> {
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
            let generation = self.owners.generation();
            if let Some(cached) = &self.selected
                && cached.scope == scope
                && cached.since == window.since_ts
                && cached.until == window.until_ts
                && cached.generation == generation
            {
                return cached.buckets.clone();
            }
            for (member, _) in self.owners.members(scope) {
                for (_, slot) in self.scope_slots(&member, window) {
                    for row in self.matching_rows(&slot.rows, window) {
                        buckets.add(row, pricing, &self.names);
                    }
                }
            }
            self.selected = Some(SelectedBuckets {
                scope: scope.into(),
                since: window.since_ts,
                until: window.until_ts,
                generation,
                buckets: buckets.clone(),
            });
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
            let mut slots = BTreeMap::<i64, Tokens>::new();
            for (member, _) in self.owners.members(scope) {
                for (&start, slot) in self.scope_slots(&member, window) {
                    slots.entry(start).or_default().merge(&self.slot_tokens(
                        start,
                        &slot.rows,
                        &slot.usage.tokens(),
                        window,
                    ));
                }
            }
            slots.into_iter().collect()
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
        let delegated = self.delegated_slots(window);
        let slots: Vec<_> = self
            .token_slots(window)
            .into_iter()
            .filter(|(_, tokens)| tokens.request_count > 0)
            .map(|(start, tokens)| {
                let mut slot = vec![
                    json!(start),
                    json!(tokens.request_count),
                    json!(tokens.prompt),
                    json!(tokens.cached),
                    json!(tokens.output),
                ];
                if window.scope.is_some() {
                    let d = delegated.get(&start).cloned().unwrap_or_default();
                    slot.extend([
                        json!(d.prompt + d.output),
                        json!(d.request_count),
                        json!(d.cached),
                        json!(d.output),
                    ]);
                }
                json!(slot)
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
