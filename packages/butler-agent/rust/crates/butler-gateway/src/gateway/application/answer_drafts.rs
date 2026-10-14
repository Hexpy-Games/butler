//! Validated draft snapshots live only in the subscriber owner.
use crate::gateway::{AppEventEnvelope, protocol::APP_PROTOCOL_VERSION};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct Drafts(HashMap<String, Value>);

impl Drafts {
    pub(super) fn sequence_end(&self, payload: &mut Value) {
        let turn = payload["turn_id"].as_str().unwrap_or_default();
        let seq = self
            .0
            .get(turn)
            .and_then(|draft| draft["ops"].as_array())
            .and_then(|ops| ops.last())
            .and_then(|op| op["seq"].as_u64())
            .unwrap_or(0)
            + 1;
        if let Some(ops) = payload["ops"].as_array_mut() {
            for op in ops {
                if op["op"] == "end" {
                    op["seq"] = json!(seq);
                }
            }
        }
    }
    pub(super) fn apply(&mut self, payload: &Value) {
        let Some(turn) = payload["turn_id"].as_str() else {
            return;
        };
        let Some(ops) = payload["ops"].as_array() else {
            return;
        };
        match self.0.entry(turn.to_owned()) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(payload.clone());
            }
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                let draft = entry.get_mut();
                if !payload["stream_id"].as_str().unwrap_or_default().is_empty()
                    && (draft["stream_id"] != payload["stream_id"]
                        || draft["call_index"] != payload["call_index"])
                {
                    *draft = payload.clone();
                } else if let Some(previous) = draft["ops"].as_array_mut() {
                    previous.extend(ops.iter().cloned());
                }
            }
        }
    }
    pub(super) fn snapshot(&self) -> AppEventEnvelope {
        envelope(
            "answer_blocks.snapshot",
            json!({"drafts":self.0.values().collect::<Vec<_>>() }),
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
        let draft = self.0.remove(turn)?;
        Some(envelope(
            "answer_blocks.draft",
            json!({
                "turn_id":turn, "session_id":draft["session_id"],
                "ops":[{"seq":draft["ops"].as_array().and_then(|ops| ops.last()).and_then(|op| op["seq"].as_u64()).unwrap_or(0) + 1,"op":"end", "outcome":state}]
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
