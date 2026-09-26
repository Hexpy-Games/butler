//! Source transcript event shapes and per-event identity.

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::{AppIdentityClock, TranscriptError, TranscriptResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TranscriptEvent {
    event_id: String,
    session_id: String,
    kind: &'static str,
    timestamp: String,
    payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<Value>,
}

pub(super) fn outbound(
    clock: &dyn AppIdentityClock,
    session_id: &str,
    mut action: Value,
    mut delivery: Value,
    metadata: Value,
) -> TranscriptResult<Vec<TranscriptEvent>> {
    let action_id = text(&action, "actionId")?.to_owned();
    let transport = text(&action, "transport")?.to_owned();
    let action = action
        .as_object_mut()
        .ok_or_else(|| error("transcript_action_invalid"))?;
    let account_id = required(action, "accountId")?;
    let peer = required(action, "peer")?;
    let message = required(action, "message")?;
    let action_metadata = action.remove("metadata").unwrap_or(Value::Null);
    let delivered = delivery
        .get("ok")
        .and_then(Value::as_bool)
        .ok_or_else(|| error("transcript_delivery_invalid"))?;
    let delivery = delivery
        .as_object_mut()
        .ok_or_else(|| error("transcript_delivery_invalid"))?;
    let transport_message_id = delivery.remove("transportMessageId").unwrap_or(Value::Null);
    let delivery_error = delivery.remove("error").unwrap_or(Value::Null);
    let raw = delivery.remove("raw").unwrap_or(Value::Null);
    let metadata = optional_metadata(metadata);
    let outbound = new_event(
        clock,
        session_id,
        "outbound",
        json!({
            "actionId": action_id,
            "accountId": account_id,
            "peer": peer,
            "message": message,
            "metadata": action_metadata,
        }),
        Some(transport.clone()),
        metadata.clone(),
    );
    let delivered = new_event(
        clock,
        session_id,
        "delivery",
        json!({
            "actionId": action_id,
            "ok": delivered,
            "transportMessageId": transport_message_id,
            "error": delivery_error,
            "raw": raw,
        }),
        Some(transport),
        metadata,
    );
    Ok(vec![outbound, delivered])
}

pub(super) fn lifecycle(
    clock: &dyn AppIdentityClock,
    session_id: &str,
    role: &str,
    state: &str,
    reason: Option<&str>,
    metadata: Value,
) -> TranscriptResult<Vec<TranscriptEvent>> {
    Ok(vec![new_event(
        clock,
        session_id,
        "session_status",
        json!({
            "role": role, "state": state, "reason": reason,
        }),
        None,
        optional_metadata(metadata),
    )])
}

fn new_event(
    clock: &dyn AppIdentityClock,
    session_id: &str,
    kind: &'static str,
    payload: Value,
    transport: Option<String>,
    metadata: Option<Value>,
) -> TranscriptEvent {
    TranscriptEvent {
        event_id: clock.new_uuid(),
        session_id: session_id.into(),
        kind,
        timestamp: clock.now_iso(),
        payload,
        transport,
        metadata,
    }
}

fn text<'a>(value: &'a Value, name: &str) -> TranscriptResult<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| error("transcript_action_invalid"))
}

fn required(value: &mut Map<String, Value>, name: &str) -> TranscriptResult<Value> {
    value
        .remove(name)
        .ok_or_else(|| error("transcript_action_invalid"))
}

fn optional_metadata(value: Value) -> Option<Value> {
    if value.is_null() { None } else { Some(value) }
}

fn error(code: &'static str) -> TranscriptError {
    TranscriptError::new(code, code)
}
