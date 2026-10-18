//! One live summary line per active turn, never stored in the App database.
use super::answer_drafts::envelope;
use crate::gateway::AppEventEnvelope;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct Thinking(HashMap<String, Value>);
impl Thinking {
    pub(super) fn apply(&mut self, payload: &Value) {
        let Some(turn) = payload["turn_id"].as_str() else {
            return;
        };
        if payload["line"].is_string() {
            self.0.insert(turn.into(), payload.clone());
        } else {
            self.0.remove(turn);
        }
    }
    pub(super) fn snapshot(&self) -> impl Iterator<Item = AppEventEnvelope> + '_ {
        self.0
            .values()
            .cloned()
            .map(|payload| envelope("turn.thinking", payload))
    }
    pub(super) fn finish(&mut self, event: &AppEventEnvelope) {
        if event.event_type != "turn.state_changed" {
            return;
        }
        let view = event
            .payload
            .get("turn")
            .and_then(Value::as_object)
            .unwrap_or(&event.payload);
        if view
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|state| {
                matches!(
                    state,
                    "delivered" | "failed" | "cancelled" | "runtime_fault"
                )
            })
            && let Some(turn) = view
                .get("turn_id")
                .or_else(|| view.get("id"))
                .and_then(Value::as_str)
        {
            self.0.remove(turn);
        }
    }
}
impl super::AppApplication {
    /// Host publication uses only the process-local subscriber path.
    pub fn publish_thinking(&self, payload: Value) {
        self.subscribers.publish_thinking(payload);
    }
}
