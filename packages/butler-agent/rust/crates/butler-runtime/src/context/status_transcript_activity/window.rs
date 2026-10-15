//! Time-indexed tool counters, folded together with the transcript activity.
use super::{StatusTranscriptActivity, StatusTranscriptToolUsageBucket};
use serde_json::Value;
use std::collections::BTreeMap;
const SLOT_MS: i64 = 900_000;
#[derive(Default)]
pub(super) struct ToolTimeline(BTreeMap<i64, ToolSlot>);
#[derive(Default)]
struct ToolSlot {
    totals: StatusTranscriptActivity,
    edges: BTreeMap<i64, StatusTranscriptActivity>,
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
        let slot = self
            .0
            .entry(ts.div_euclid(SLOT_MS).saturating_mul(SLOT_MS))
            .or_default();
        let mut count = StatusTranscriptToolUsageBucket::default();
        if is_call {
            count.calls = 1;
        } else {
            count.results = 1;
            if ok {
                count.successes = 1;
            } else {
                count.failures = 1;
            }
        }
        for target in [&mut slot.totals, slot.edges.entry(ts).or_default()] {
            merge_bucket(&mut target.tools, &count);
            merge_bucket(target.by_tool.entry(name.into()).or_default(), &count);
        }
    }
    pub(super) fn read(&self, since: f64, until: f64, target: &mut StatusTranscriptActivity) {
        let first = butler_core::json::saturating_i64(since)
            .div_euclid(SLOT_MS)
            .saturating_mul(SLOT_MS);
        let last = butler_core::json::saturating_i64(until)
            .div_euclid(SLOT_MS)
            .saturating_mul(SLOT_MS);
        for (&start, slot) in self.0.range(first..=last) {
            if since <= start as f64 && until >= start.saturating_add(SLOT_MS) as f64 {
                merge(target, &slot.totals);
            } else {
                for (&ts, counts) in &slot.edges {
                    if ts as f64 >= since && (ts as f64) < until {
                        merge(target, counts);
                    }
                }
            }
        }
    }
}
fn merge(target: &mut StatusTranscriptActivity, source: &StatusTranscriptActivity) {
    merge_bucket(&mut target.tools, &source.tools);
    for (name, count) in &source.by_tool {
        merge_bucket(target.by_tool.entry(name.clone()).or_default(), count);
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
