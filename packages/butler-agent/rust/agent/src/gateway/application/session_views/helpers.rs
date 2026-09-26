use serde_json::{Map, Value, json};

use crate::gateway::{GatewayApplicationError, MessageRecord, TurnRecord, TurnState};

pub(super) fn is_child_session(session_id: &str) -> bool {
    session_id.starts_with("steward-") || session_id.starts_with("worker-")
}

pub(super) fn active_state(state: &TurnState) -> bool {
    !matches!(
        state,
        TurnState::Delivered | TurnState::Cancelled | TurnState::Failed | TurnState::RuntimeFault
    )
}

pub(super) fn view_status(turn: Option<&TurnRecord>) -> &'static str {
    match turn.map(|turn| &turn.state) {
        None => "idle",
        Some(state) if active_state(state) => "active",
        Some(TurnState::Cancelled) => "cancelled",
        Some(TurnState::Failed | TurnState::RuntimeFault) => "failed",
        Some(_) => "delivered",
    }
}

pub(super) fn turn_state_name(state: &TurnState) -> &'static str {
    match state {
        TurnState::Queued => "queued",
        TurnState::Accepted => "accepted",
        TurnState::Thinking => "thinking",
        TurnState::Streaming => "streaming",
        TurnState::WaitingForForm => "waiting_for_form",
        TurnState::WaitingForTool => "waiting_for_tool",
        TurnState::Cancelling => "cancelling",
        TurnState::Cancelled => "cancelled",
        TurnState::Delivered => "delivered",
        TurnState::RuntimeFault => "runtime_fault",
        TurnState::Failed => "failed",
        TurnState::Retrying => "retrying",
    }
}

pub(super) fn safe_errors(messages: &[MessageRecord]) -> Vec<Value> {
    messages
        .iter()
        .rev()
        .filter_map(|message| {
            Some(json!({
                "code": message.safe_error_code.as_ref()?,
                "message": "A safe app-visible error occurred.",
                "created_at": message.updated_at,
            }))
        })
        .take(5)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

pub(super) fn child_status(projection: &Value) -> &'static str {
    match projection.get("status").and_then(Value::as_str) {
        Some("completed" | "delivered") => "delivered",
        Some("cancelled") => "cancelled",
        Some("blocked" | "failed") => "failed",
        Some("active" | "waiting") => "active",
        _ => "idle",
    }
}

pub(super) fn child_updated_at(projection: &Value) -> Option<&str> {
    projection
        .pointer("/latest_turn/updated_at")
        .and_then(Value::as_str)
        .or_else(|| projection.get("updated_at").and_then(Value::as_str))
}

pub(super) fn require_relation(projection: &Value) -> Result<(), GatewayApplicationError> {
    if projection
        .get("relation")
        .is_some_and(|value| !value.is_null())
    {
        Ok(())
    } else {
        Err(GatewayApplicationError::Public {
            status: 404,
            code: "session_not_found".into(),
            message: "Session not found.".into(),
        })
    }
}

pub(super) fn copy(output: &mut Map<String, Value>, key: &str, source: &Value) {
    if let Some(value) = source.get(key) {
        output.insert(key.into(), value.clone());
    }
}

pub(super) fn copy_as(output: &mut Map<String, Value>, target: &str, key: &str, source: &Value) {
    if let Some(value) = source.get(key) {
        output.insert(target.into(), value.clone());
    }
}

pub(super) fn insert_some(output: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        output.insert(key.into(), value);
    }
}

pub(super) fn serialize_option<T: serde::Serialize>(
    value: Option<&T>,
) -> Result<Value, GatewayApplicationError> {
    serde_json::to_value(value).map_err(json_error)
}

pub(super) fn json_error(_: serde_json::Error) -> GatewayApplicationError {
    GatewayApplicationError::Internal
}
