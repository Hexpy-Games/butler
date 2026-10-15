//! Per-slot counters and compact boundary records; names are interned per file.
use super::{MAX_TOOL_KEYS, StatusTranscriptActivity, StatusTranscriptToolUsageBucket};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};
const SLOT_MS: i64 = 900_000;
#[derive(Default)]
pub(super) struct ToolTimeline {
    slots: BTreeMap<i64, ToolSlot>,
    names: Vec<Arc<str>>,
    ids: HashMap<Arc<str>, u16>,
}
#[derive(Default)]
struct ToolSlot {
    totals: BTreeMap<u16, StatusTranscriptToolUsageBucket>,
    edges: Vec<Edge>,
}
struct Edge {
    ts: i64,
    tool: u16,
    kind: u8,
}
impl ToolTimeline {
    pub(super) fn add(&mut self, event: &Value, name: &str, is_call: bool, ok: bool) {
        let Some(ts) = event
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(butler_core::js_date::parse_iso_millis)
        else {
            return;
        };
        let name = if self.ids.contains_key(name) || self.ids.len() < MAX_TOOL_KEYS {
            name
        } else {
            "__other__"
        };
        let tool = self.ids.get(name).copied().unwrap_or_else(|| {
            // At most MAX_TOOL_KEYS names plus __other__ are interned.
            #[expect(clippy::cast_possible_truncation, reason = "bounded tool dictionary")]
            let id = self.names.len() as u16;
            let shared: Arc<str> = Arc::from(name);
            self.names.push(shared.clone());
            self.ids.insert(shared, id);
            id
        });
        let kind = if is_call {
            0
        } else if ok {
            1
        } else {
            2
        };
        let slot = self
            .slots
            .entry(ts.div_euclid(SLOT_MS).saturating_mul(SLOT_MS))
            .or_default();
        increment(slot.totals.entry(tool).or_default(), kind);
        slot.edges.push(Edge { ts, tool, kind });
    }
    pub(super) fn read(&self, since: f64, until: f64, target: &mut StatusTranscriptActivity) {
        let first = butler_core::json::saturating_i64(since)
            .div_euclid(SLOT_MS)
            .saturating_mul(SLOT_MS);
        let last = butler_core::json::saturating_i64(until)
            .div_euclid(SLOT_MS)
            .saturating_mul(SLOT_MS);
        for (&start, slot) in self.slots.range(first..=last) {
            if since <= start as f64 && until >= start.saturating_add(SLOT_MS) as f64 {
                for (id, count) in &slot.totals {
                    self.merge(target, *id, count);
                }
            } else {
                for edge in &slot.edges {
                    if edge.ts as f64 >= since && (edge.ts as f64) < until {
                        let mut count = StatusTranscriptToolUsageBucket::default();
                        increment(&mut count, edge.kind);
                        self.merge(target, edge.tool, &count);
                    }
                }
            }
        }
    }
    fn merge(
        &self,
        target: &mut StatusTranscriptActivity,
        id: u16,
        count: &StatusTranscriptToolUsageBucket,
    ) {
        merge_bucket(&mut target.tools, count);
        let name = &self.names[usize::from(id)];
        let key =
            if target.by_tool.contains_key(name.as_ref()) || target.by_tool.len() < MAX_TOOL_KEYS {
                name.as_ref()
            } else {
                "__other__"
            };
        if key == "__other__"
            && !target.by_tool.contains_key(key)
            && target.by_tool.len() >= MAX_TOOL_KEYS
            && let Some((_, overflow)) = target.by_tool.pop_last()
        {
            merge_bucket(target.by_tool.entry(key.into()).or_default(), &overflow);
        }
        merge_bucket(target.by_tool.entry(key.into()).or_default(), count);
    }
}
fn increment(target: &mut StatusTranscriptToolUsageBucket, kind: u8) {
    match kind {
        0 => target.calls += 1,
        1 => {
            target.results += 1;
            target.successes += 1;
        }
        _ => {
            target.results += 1;
            target.failures += 1;
        }
    }
}
fn merge_bucket(
    target: &mut StatusTranscriptToolUsageBucket,
    source: &StatusTranscriptToolUsageBucket,
) {
    target.calls += source.calls;
    target.results += source.results;
    target.successes += source.successes;
    target.failures += source.failures;
}
