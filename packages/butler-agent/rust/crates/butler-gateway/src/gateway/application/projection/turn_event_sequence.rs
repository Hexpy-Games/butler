//! Bounded replay seed lookup for canonical App Turn-event sequences.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value};

use crate::gateway::application::storage::AppStorageError;

pub(super) fn next_sequence(
    db: &Connection,
    identity_key: &str,
    identity: &str,
) -> Result<u64, AppStorageError> {
    let (scope_field, sequence_field, sql) = if identity_key == "sessionId" {
        (
            "session_id",
            "sessionSequence",
            "SELECT payload_json FROM events \
             WHERE type='agent.turn_event' \
             AND json_extract(payload_json,'$.session_id')=?1 \
             ORDER BY id DESC LIMIT 20",
        )
    } else {
        let indexed = db
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name='events_turn_id_idx'",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(AppStorageError::sqlite)?
            .is_some();
        let sql = if indexed {
            "SELECT payload_json FROM events \
             WHERE type='agent.turn_event' AND turn_id<>'' AND turn_id=?1 \
             ORDER BY id DESC LIMIT 20"
        } else {
            "SELECT payload_json FROM events \
             WHERE type='agent.turn_event' \
             AND json_extract(payload_json,'$.turn_id')=?1 \
             ORDER BY id DESC LIMIT 20"
        };
        ("turn_id", "turnSequence", sql)
    };
    latest_positive_sequence(db, sql, scope_field, sequence_field, identity)
        .map(|latest| latest + 1)
}

fn latest_positive_sequence(
    db: &Connection,
    sql: &str,
    scope_field: &str,
    sequence_field: &str,
    identity: &str,
) -> Result<u64, AppStorageError> {
    let mut statement = db.prepare(sql).map_err(AppStorageError::sqlite)?;
    let mut rows = statement
        .query([identity])
        .map_err(AppStorageError::sqlite)?;
    while let Some(row) = rows.next().map_err(AppStorageError::sqlite)? {
        let payload_json: String = row.get(0).map_err(AppStorageError::sqlite)?;
        let payload = serde_json::from_str::<Map<String, Value>>(&payload_json).unwrap_or_default();
        if payload.get(scope_field).and_then(Value::as_str) != Some(identity) {
            continue;
        }
        let sequence = payload
            .get("event")
            .and_then(Value::as_object)
            .and_then(|event| event.get(sequence_field))
            .and_then(Value::as_u64)
            .filter(|sequence| *sequence > 0);
        if let Some(sequence) = sequence {
            return Ok(sequence);
        }
    }
    Ok(0)
}
