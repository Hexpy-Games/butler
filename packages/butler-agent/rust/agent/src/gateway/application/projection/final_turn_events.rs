//! Canonical public Turn-event envelopes emitted by final projection.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::gateway::application::{events::EventSubscribers, storage::AppStorageError};

pub(super) struct FinalTurnEventIds {
    pub started: String,
    pub completed: String,
    pub turn_completed: String,
    pub failed: String,
}

pub(super) struct TurnEventInput<'a> {
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub kind: &'a str,
    pub payload: Map<String, Value>,
    pub event_id: &'a str,
    pub created_at: &'a str,
}

pub(super) fn append_if_missing(
    db: &Connection,
    subscribers: &EventSubscribers,
    input: TurnEventInput<'_>,
) -> Result<(), AppStorageError> {
    if has_kind(db, input.turn_id, input.kind)? {
        return Ok(());
    }
    let session_sequence =
        super::turn_event_sequence::next_sequence(db, "sessionId", input.session_id)?;
    let turn_sequence = super::turn_event_sequence::next_sequence(db, "turnId", input.turn_id)?;
    let event = json!({
        "id": input.event_id,
        "sessionId": input.session_id,
        "turnId": input.turn_id,
        "sessionSequence": session_sequence,
        "turnSequence": turn_sequence,
        "createdAt": input.created_at,
        "kind": input.kind,
        "visibility": "public",
        "payload": input.payload,
    });
    super::super::events::append(
        db,
        subscribers,
        "agent.turn_event",
        Some(input.turn_id),
        object(json!({"session_id":input.session_id,"turn_id":input.turn_id,"event":event}))?,
        input.created_at,
    )?;
    Ok(())
}

fn has_kind(db: &Connection, turn_id: &str, kind: &str) -> Result<bool, AppStorageError> {
    db.query_row(
        "SELECT 1 FROM events WHERE type='agent.turn_event' AND turn_id=?1 \
         AND json_extract(payload_json,'$.event.kind')=?2 ORDER BY id DESC LIMIT 1",
        params![turn_id, kind],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(AppStorageError::sqlite)
}

fn object(value: Value) -> Result<Map<String, Value>, AppStorageError> {
    value.as_object().cloned().ok_or_else(|| {
        AppStorageError::new("app_event_payload_invalid", "Event payload is invalid.")
    })
}
