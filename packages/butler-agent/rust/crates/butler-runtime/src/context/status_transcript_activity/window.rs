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
    offset_ms: u32,
    tool: u16,
    kind: u8,
}
impl ToolTimeline {
    pub(super) fn add(&mut self, event: &Value, name: &str, is_call: bool, ok: bool) {
        let name = if self.ids.contains_key(name)
            || self.ids.len() < MAX_TOOL_KEYS - usize::from(!self.ids.contains_key("__other__"))
        {
            name
        } else {
            "__other__"
        };
        let tool = self.ids.get(name).copied().unwrap_or_else(|| {
            // Reserve one of MAX_TOOL_KEYS dictionary entries for overflow.
            #[expect(clippy::cast_possible_truncation, reason = "bounded tool dictionary")]
            let id = self.names.len() as u16;
            let shared: Arc<str> = Arc::from(name);
            self.names.push(shared.clone());
            self.ids.insert(shared, id);
            id
        });
        let Some(ts) = event
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(butler_core::js_date::parse_iso_millis)
        else {
            return;
        };
        let kind = if is_call {
            0
        } else if ok {
            1
        } else {
            2
        };
        let start = ts.div_euclid(SLOT_MS).saturating_mul(SLOT_MS);
        let slot = self.slots.entry(start).or_default();
        increment(slot.totals.entry(tool).or_default(), kind);
        let offset_ms = u32::try_from(ts.rem_euclid(SLOT_MS)).unwrap_or_default();
        slot.edges.push(Edge {
            offset_ms,
            tool,
            kind,
        });
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
                    let ts = start.saturating_add(i64::from(edge.offset_ms)) as f64;
                    if ts >= since && ts < until {
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
        // Membership is fixed in file order at ingest, as in all-time reads.
        let reserve = usize::from(!target.by_tool.contains_key("__other__"));
        let key = if target.by_tool.contains_key(name.as_ref())
            || target.by_tool.len() < MAX_TOOL_KEYS - reserve
        {
            name.as_ref()
        } else {
            "__other__"
        };
        merge_bucket(target.by_tool.entry(key.to_owned()).or_default(), count);
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
