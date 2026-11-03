//! Current child turn enrichment from canonical conversation delivery.
use super::turn_state;
use butler_turn::conversation::ConversationTurn;
use serde_json::{Map, Value};

pub(super) fn project_turn(object: &mut Map<String, Value>, turn: &ConversationTurn) {
    let recoverable = object
        .get("latest_turn")
        .and_then(|turn| turn.get("retryable"))
        .and_then(serde_json::Value::as_bool)
        == Some(true);
    let state = if object
        .get("latest_turn")
        .and_then(|value| value.get("state"))
        .and_then(serde_json::Value::as_str)
        == Some("cancelled")
    {
        "cancelled"
    } else if recoverable {
        "runtime_fault"
    } else {
        turn_state(&turn.status)
    };
    let projected = serde_json::json!({
        "id": turn.id, "state": state, "created_at": turn.started_at,
        "updated_at": turn.completed_at.as_deref().unwrap_or(&turn.started_at),
        "cancellable": state == "thinking", "retryable": recoverable,
    });
    object.insert("latest_turn".into(), projected.clone());
    object.insert(
        "active_turn".into(),
        if state == "thinking" {
            projected
        } else {
            serde_json::Value::Null
        },
    );
}
