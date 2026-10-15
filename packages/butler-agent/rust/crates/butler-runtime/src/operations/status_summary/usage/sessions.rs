//! Global session totals reuse complete slots; exact boundaries stay request-local.
use super::{SLOT_MS, SessionUsage, UsageLogIndex, Window, complete, slot_start};
use serde_json::{Value, json};
use std::collections::HashMap;

const TOP_SESSIONS_LIMIT: usize = 200;

pub(super) struct SessionCache {
    start: i64,
    end: i64,
    totals: HashMap<String, SessionUsage>,
}

impl UsageLogIndex {
    pub(in super::super) fn session_turns(
        &self,
        view: &Value,
    ) -> HashMap<String, std::collections::HashSet<String>> {
        let window = Window {
            scope: None,
            since_ts: view["filters"]["sinceTs"].as_f64(),
            until_ts: view["filters"]["untilTs"].as_f64(),
        };
        view["topSessions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item["sessionId"].as_str())
            .filter_map(|id| {
                let guided = format!("btcc-guided:{id}");
                let mut rows = [id, guided.as_str()]
                    .into_iter()
                    .flat_map(|scope| self.scope_slots(scope, window))
                    .flat_map(|(_, slot)| self.matching_rows(&slot.rows, window));
                // Missing turn provenance prevents schedule classification.
                let turns = rows.try_fold(std::collections::HashSet::new(), |mut ids, row| {
                    ids.insert(row.turn_id.as_ref()?.to_string());
                    Some(ids)
                })?;
                (!turns.is_empty()).then(|| (id.to_owned(), turns))
            })
            .collect()
    }
    pub(in super::super) fn top_sessions(&mut self, window: Window<'_>) -> Value {
        // The selector remains global when the chart is filtered to a session.
        let global = Window {
            scope: None,
            ..window
        };
        let mut scopes = self.complete_session_totals(global);
        self.add_boundary_sessions(global, &mut scopes);
        scopes.retain(|_, value| value.requests > 0);
        let selected_scope = window
            .scope
            .map(|scope| scope.strip_prefix("btcc-guided:").unwrap_or(scope));
        if let Some(scope) = selected_scope {
            scopes.entry(scope.into()).or_default();
        }
        let mut scopes: Vec<_> = scopes.into_iter().collect();
        scopes.sort_by(|a, b| b.1.total.total_cmp(&a.1.total).then_with(|| a.0.cmp(&b.0)));
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
                    let kind = if self.by_scope.contains_key(guided.as_str()) {
                        "chat"
                    } else {
                        "butler"
                    };
                    json!({
                        "sessionId": scope, "title": null, "kind": kind,
                        "totalTokens": usage.total, "requests": usage.requests,
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
            && cache.start == start
            && cache.end == end
        {
            return cache.totals.clone();
        }
        let mut totals = HashMap::<String, SessionUsage>::new();
        if start < end {
            for (scope, slots) in &self.by_scope {
                let session = scope.strip_prefix("btcc-guided:").unwrap_or(scope);
                let target = totals.entry(session.to_owned()).or_default();
                for (_, slot) in slots.range(start..end) {
                    target.merge(&slot.usage);
                }
            }
        }
        self.session_totals = Some(SessionCache {
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
                let session = scope.strip_prefix("btcc-guided:").unwrap_or(scope);
                for row in self.matching_rows(&slot.rows, window) {
                    totals.entry(session.to_owned()).or_default().add(row);
                }
            }
        }
    }
}
