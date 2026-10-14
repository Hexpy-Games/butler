//! Validated draft snapshots live only in the subscriber owner.
use crate::gateway::{AppEventEnvelope, protocol::APP_PROTOCOL_VERSION};
use serde_json::{Value, json};
use std::collections::HashMap;

/// Per turn, the draft payloads in arrival order. Consecutive payloads of one
/// call share an entry, so a reconnect replays every call (parallel calls,
/// later calls and retries) in the order the App saw them.
#[derive(Default)]
pub(super) struct Drafts(HashMap<String, Vec<Value>>);

fn same_call(a: &Value, b: &Value) -> bool {
    ["stream_id", "call_index", "call_id"]
        .iter()
        .all(|key| a.get(*key) == b.get(*key))
}

fn next_seq(entries: &[Value]) -> u64 {
    entries
        .last()
        .and_then(|entry| entry["ops"].as_array())
        .and_then(|ops| ops.iter().rev().find_map(|op| op["seq"].as_u64()))
        .unwrap_or(0)
        + 1
}

impl Drafts {
    pub(super) fn sequence_end(&self, payload: &mut Value) {
        let turn = payload["turn_id"].as_str().unwrap_or_default();
        let seq = self.0.get(turn).map_or(1, |entries| next_seq(entries));
        if let Some(ops) = payload["ops"].as_array_mut() {
            for op in ops {
                if op["op"] == "end" {
                    op["seq"] = json!(seq);
                }
            }
        }
    }
    pub(super) fn apply(&mut self, payload: &Value) {
        let (Some(turn), Some(ops)) = (payload["turn_id"].as_str(), payload["ops"].as_array())
        else {
            return;
        };
        let entries = self.0.entry(turn.to_owned()).or_default();
        if let Some(last) = entries.last_mut()
            && same_call(last, payload)
            && let Some(previous) = last["ops"].as_array_mut()
        {
            previous.extend(ops.iter().cloned());
        } else {
            entries.push(payload.clone());
        }
    }
    pub(super) fn snapshot(&self) -> AppEventEnvelope {
        envelope(
            "answer_blocks.snapshot",
            json!({"drafts":self.0.values().flatten().collect::<Vec<_>>() }),
        )
    }
    pub(super) fn finish(&mut self, event: &AppEventEnvelope) -> Option<AppEventEnvelope> {
        let payload = &event.payload;
        if event.event_type != "turn.state_changed" {
            return None;
        }
        let view = payload
            .get("turn")
            .and_then(Value::as_object)
            .unwrap_or(payload);
        let state = view.get("state").and_then(Value::as_str)?;
        if !matches!(
            state,
            "delivered" | "failed" | "cancelled" | "runtime_fault"
        ) {
            return None;
        }
        let turn = view
            .get("turn_id")
            .or_else(|| view.get("id"))
            .and_then(Value::as_str)?;
        let entries = self.0.remove(turn)?;
        Some(envelope(
            "answer_blocks.draft",
            json!({
                "turn_id":turn, "session_id":entries.first().map(|entry| entry["session_id"].clone()),
                "ops":[{"seq":next_seq(&entries),"op":"end", "outcome":state}]
            }),
        ))
    }
}

pub(super) fn envelope(kind: &str, payload: Value) -> AppEventEnvelope {
    AppEventEnvelope {
        protocol_version: APP_PROTOCOL_VERSION.into(),
        id: 0,
        event_type: kind.into(),
        created_at: butler_core::js_date::iso_from_system_time(std::time::SystemTime::now()),
        payload: match payload {
            Value::Object(object) => object,
            _ => Default::default(),
        },
    }
}

impl super::AppApplication {
    /// The host supplies parsed, evidence-validated ops through the ephemeral port.
    pub fn publish_answer_draft(&self, payload: Value) {
        self.subscribers.publish_draft(payload);
    }
}
