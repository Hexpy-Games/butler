//! Global session totals reuse complete slots; exact boundaries stay request-local.
use super::{SLOT_MS, SessionUsage, UsageLogIndex, UsageScope, Window, complete, slot_start};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const TOP_SESSIONS_LIMIT: usize = 200;

pub(super) struct SessionCache {
    generation: u64,
    start: i64,
    end: i64,
    totals: HashMap<String, SessionUsage>,
}

impl UsageLogIndex {
    pub(in super::super) fn scheduled_sessions<E>(
        &self,
        view: &Value,
        mut is_scheduled: impl FnMut(&str) -> Result<bool, E>,
    ) -> Result<HashSet<String>, E> {
        let window = Window {
            scope: None,
            since_ts: view["filters"]["sinceTs"].as_f64(),
            until_ts: view["filters"]["untilTs"].as_f64(),
        };
        let mut scheduled = HashSet::new();
        for id in view["topSessions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item["sessionId"].as_str())
        {
            let guided = format!("btcc-guided:{id}");
            let rows = [id, guided.as_str()]
                .into_iter()
                .flat_map(|scope| self.scope_slots(&UsageScope::legacy(scope), window))
                .flat_map(|(_, slot)| self.matching_rows(&slot.rows, window));
            let mut turns = HashSet::new();
            let mut all_scheduled = true;
            for row in rows {
                // Borrow interned ids and stop as soon as this session cannot
                // be a schedule. Missing provenance is also non-schedule.
                let Some(turn) = row.turn_id.as_deref() else {
                    all_scheduled = false;
                    break;
                };
                if turns.insert(turn) && !is_scheduled(turn)? {
                    all_scheduled = false;
                    break;
                }
            }
            if all_scheduled && !turns.is_empty() {
                scheduled.insert(id.to_owned());
            }
        }
        Ok(scheduled)
    }
    pub(in super::super) fn top_sessions(&mut self, window: Window<'_>) -> Value {
        // The selector remains global when the chart is filtered to a session.
        let global = Window {
            scope: None,
            ..window
        };
        let mut scopes = self.complete_session_totals(global);
        self.add_boundary_sessions(global, &mut scopes);
        scopes.retain(|_, value| value.tokens.request_count > 0);
        let selected_scope = window
            .scope
            .map(|scope| scope.strip_prefix("btcc-guided:").unwrap_or(scope));
        if let Some(scope) = selected_scope {
            scopes.entry(scope.into()).or_default();
        }
        let mut scopes: Vec<_> = scopes.into_iter().collect();
        scopes.sort_by(|a, b| {
            b.1.tokens
                .total
                .total_cmp(&a.1.tokens.total)
                .then_with(|| a.0.cmp(&b.0))
        });
        let selected =
            selected_scope.and_then(|scope| scopes.iter().position(|item| item.0 == scope));
        let mut keep: Vec<_> = (0..scopes.len().min(TOP_SESSIONS_LIMIT)).collect();
        if let Some(index) = selected.filter(|index| *index >= TOP_SESSIONS_LIMIT) {
            keep.push(index);
        }
        json!(
            keep.into_iter()
                .map(|index| {
                    let (scope, usage) = &scopes[index];
                    let guided = format!("btcc-guided:{scope}");
                    let kind = if self.scope_names.contains(guided.as_str())
                        || self.owners.is_chat_root(scope)
                    {
                        "chat"
                    } else {
                        "butler"
                    };
                    json!({
                        "sessionId": scope, "title": null, "kind": kind,
                        "totalTokens": usage.tokens.total, "requests": usage.tokens.request_count,
                        "lastUsedMs": usage.last
                    })
                })
                .collect::<Vec<_>>()
        )
    }
    fn complete_session_totals(&mut self, window: Window<'_>) -> HashMap<String, SessionUsage> {
        let start = window.since_ts.map_or(i64::MIN, |ts| {
            let slot = slot_start(ts);
            if ts > slot as f64 {
                slot.saturating_add(SLOT_MS)
            } else {
                slot
            }
        });
        let end = window.until_ts.map_or(i64::MAX, slot_start);
        if let Some(cache) = &self.session_totals
            && cache.generation == self.owners.generation()
            && cache.start == start
            && cache.end == end
        {
            return cache.totals.clone();
        }
        let mut totals = HashMap::<String, SessionUsage>::new();
        if start < end {
            for (scope, slots) in &self.by_scope {
                let owner_scope = self.owners.scope_root(scope);
                let session = owner_scope
                    .strip_prefix("btcc-guided:")
                    .unwrap_or(&owner_scope);
                let target = totals.entry(session.to_owned()).or_default();
                for (_, slot) in slots.range(start..end) {
                    target.merge(&slot.usage);
                }
            }
        }
        self.session_totals = Some(SessionCache {
            generation: self.owners.generation(),
            start,
            end,
            totals: totals.clone(),
        });
        totals
    }

    fn add_boundary_sessions(
        &self,
        window: Window<'_>,
        totals: &mut HashMap<String, SessionUsage>,
    ) {
        let first = window.since_ts.map(slot_start);
        let last = window
            .until_ts
            .map(slot_start)
            .filter(|last| Some(*last) != first);
        for start in [first, last]
            .into_iter()
            .flatten()
            .filter(|&start| !complete(start, window))
        {
            for (scope, slots) in &self.by_scope {
                let Some(slot) = slots.get(&start) else {
                    continue;
                };
                let owner_scope = self.owners.scope_root(scope);
                let session = owner_scope
                    .strip_prefix("btcc-guided:")
                    .unwrap_or(&owner_scope);
                for row in self.matching_rows(&slot.rows, window) {
                    totals.entry(session.to_owned()).or_default().add(row);
                }
            }
        }
    }
}
