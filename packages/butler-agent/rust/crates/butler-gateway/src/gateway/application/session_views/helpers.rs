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
    if projection
        .pointer("/latest_turn/retryable")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return "failed";
    }
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
            source: None,
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
    GatewayApplicationError::internal()
}

/// Whether a delivered turn without a user message was superseded by a
/// later standalone assistant reply, so its progress rows are hidden.
pub(super) fn superseded_by_reply(
    latest: Option<&TurnRecord>,
    latest_message: Option<&MessageRecord>,
) -> bool {
    latest.is_some_and(|turn| {
        turn.user_message_id.is_none()
            && matches!(&turn.state, &TurnState::Delivered)
            && latest_message.is_some_and(|message| {
                matches!(&message.role, &crate::gateway::MessageRole::Assistant)
                    && message.turn_id.is_none()
                    && message.created_at.as_str() >= turn.created_at.as_str()
            })
    })
}

pub(super) fn insert_session_identity(
    view: &mut Map<String, Value>,
    session: &super::super::AppSessionSummary,
    status: &str,
) {
    view.insert(
        "protocol_version".into(),
        json!(crate::gateway::protocol::APP_PROTOCOL_VERSION),
    );
    view.insert("session_id".into(), json!(session.id));
    view.insert("kind".into(), json!(session.kind));
    insert_some(
        view,
        "project_id",
        session.project_id.clone().map(Value::String),
    );
    insert_some(view, "branch_seed", session.branch_seed.clone());
    view.insert("status".into(), json!(status));
}
pub(super) fn insert_message_window(
    view: &mut Map<String, Value>,
    next: u64,
    first: Option<u64>,
    has_more: bool,
) {
    view.insert("message_window".into(), json!({"next_cursor":next,"complete":!has_more,"has_more":has_more,"previous_cursor":first}));
}

pub(super) fn insert_timestamps(
    view: &mut Map<String, Value>,
    now: &str,
    fallback: &str,
    latest: Option<&TurnRecord>,
    message: Option<&MessageRecord>,
) {
    view.insert("generated_at".into(), json!(now));
    view.insert(
        "updated_at".into(),
        json!(
            latest
                .map(|turn| turn.updated_at.as_str())
                .or_else(|| message.map(|message| message.updated_at.as_str()))
                .unwrap_or(fallback)
        ),
    );
}

pub(super) fn insert_turns<T: serde::Serialize>(
    view: &mut Map<String, Value>,
    active: Option<&T>,
    latest: Option<&T>,
) -> Result<(), GatewayApplicationError> {
    view.insert("active_turn".into(), serialize_option(active)?);
    view.insert("latest_turn".into(), serialize_option(latest)?);
    Ok(())
}

/// Message content, paging metadata and errors come from the same snapshot.
pub(super) fn insert_messages(
    view: &mut Map<String, Value>,
    messages: &crate::gateway::MessageListView,
    has_more: bool,
    event_cursor: u64,
) -> Result<(), GatewayApplicationError> {
    let next = butler_core::json::saturating_u64(messages.next_cursor);
    let first = messages.messages.first().map(|message| message.cursor);
    view.insert(
        "messages".into(),
        serde_json::to_value(&messages.messages).map_err(json_error)?,
    );
    insert_message_window(view, next, first, has_more);
    view.insert("errors".into(), json!(safe_errors(&messages.messages)));
    view.insert(
        "cursors".into(),
        json!({"messages": next, "events": event_cursor}),
    );
    Ok(())
}
