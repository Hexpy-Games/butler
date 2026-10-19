//! One live summary line per active turn, never stored in the App database.
use super::answer_drafts::envelope;
use crate::gateway::AppEventEnvelope;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct Thinking {
    turns: HashMap<String, Value>,
    pub(super) enabled: bool,
}
impl Thinking {
    fn project(&self, mut payload: Value) -> Value {
        if (!self.enabled || payload["summary"].is_null())
            && let Some(fields) = payload.as_object_mut()
        {
            fields.remove("summary");
        }
        payload
    }
    pub(super) fn update(&mut self, payload: Value) -> Option<Value> {
        let previous = payload["turn_id"]
            .as_str()
            .and_then(|turn| self.turns.get(turn))
            .cloned();
        self.apply(&payload);
        let projected = self.project(payload);
        if previous
            .as_ref()
            .map(|old| self.project(old.clone()))
            .as_ref()
            == Some(&projected)
        {
            return None;
        }
        // Before a heading exists, Option A has nothing to show.
        if !self.enabled && projected["line"].is_null() && previous.is_none() {
            return None;
        }
        Some(projected)
    }
    pub(super) fn preference(&mut self, event: &AppEventEnvelope) -> bool {
        if event.event_type != "settings.updated" {
            return false;
        }
        let enabled = event.payload["settings"]["show_thinking"] == true;
        let changed = enabled != self.enabled;
        self.enabled = enabled;
        butler_turn::btcc::set_thinking_capture(enabled);
        changed
    }
    pub(super) fn apply(&mut self, payload: &Value) {
        let Some(turn) = payload["turn_id"].as_str() else {
            return;
        };
        if payload["line"].is_string() || payload["summary"].is_string() {
            self.turns.insert(turn.into(), payload.clone());
        } else {
            self.turns.remove(turn);
        }
    }
    pub(super) fn snapshot(&self) -> impl Iterator<Item = AppEventEnvelope> + '_ {
        self.turns
            .values()
            .filter(|payload| self.enabled || payload["line"].is_string())
            .cloned()
            .map(|payload| envelope("turn.thinking", self.project(payload)))
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
            self.turns.remove(turn);
        }
    }
}
impl super::AppApplication {
    /// Host publication uses only the process-local subscriber path.
    pub fn publish_thinking(&self, payload: Value) {
        self.subscribers.publish_thinking(payload);
    }
}
