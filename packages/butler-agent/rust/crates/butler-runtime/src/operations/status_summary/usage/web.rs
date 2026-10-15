//! Incremental search-log slots; unchanged reads never parse the log again.
use super::{
    super::stream::number,
    log::{SLOT_MS, slot_start},
};
use crate::operations::log_tail::LogTail;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};
#[derive(Default)]
pub(super) struct SearchIndex {
    tail: LogTail,
    slots: BTreeMap<i64, SearchSlot>,
}
#[derive(Default)]
struct SearchSlot {
    count: u64,
    latest: Option<Search>,
    edges: Vec<Search>,
}
#[derive(Clone)]
struct Search {
    ts: f64,
    provider: String,
    error: Option<String>,
}
impl SearchIndex {
    pub(super) fn read(&mut self, root: &Path, since: f64, until: f64) -> Value {
        let mut tail = std::mem::take(&mut self.tail);
        tail.advance(
            &root.join("metrics/web-search-usage.jsonl"),
            self,
            |index| index.slots.clear(),
            Self::push,
        );
        self.tail = tail;
        let first = slot_start(since);
        let mut count = 0;
        let mut latest = None;
        for (&start, slot) in self.slots.range(first..=slot_start(until)) {
            if start as f64 >= since && start.saturating_add(SLOT_MS) as f64 <= until {
                count += slot.count;
                if let Some(search) = &slot.latest {
                    update_latest(&mut latest, search);
                }
            } else {
                for search in slot
                    .edges
                    .iter()
                    .filter(|row| row.ts >= since && row.ts < until)
                {
                    count += 1;
                    update_latest(&mut latest, search);
                }
            }
        }
        json!({"requestCount":count,"lastProvider":latest.map(|row| &row.provider),
            "lastError":latest.and_then(|row| row.error.as_ref())})
    }
    fn push(&mut self, line: &[u8]) {
        let Ok(event) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        let Some(ts) = number(event.get("ts")) else {
            return;
        };
        let Some(provider) = event
            .get("provider")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        else {
            return;
        };
        let search = Search {
            ts,
            provider: provider.into(),
            error: event
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned),
        };
        let start = slot_start(ts);
        let slot = self.slots.entry(start).or_default();
        slot.count += 1;
        if slot.latest.as_ref().is_none_or(|row| row.ts <= ts) {
            slot.latest = Some(search.clone());
        }
        slot.edges.push(search);
    }
}
fn update_latest<'a>(latest: &mut Option<&'a Search>, row: &'a Search) {
    if latest.is_none_or(|current| current.ts <= row.ts) {
        *latest = Some(row);
    }
}
