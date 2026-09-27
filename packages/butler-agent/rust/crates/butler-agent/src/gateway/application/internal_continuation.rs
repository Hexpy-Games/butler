//! Durable identities for progress rows that represent invisible continuation work.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::storage::AppStorageError;

const DELETE_BATCH: usize = 64;

pub(super) fn remember(
    db: &Connection,
    turn: &str,
    event: &Map<String, Value>,
) -> Result<(), AppStorageError> {
    let Some(event_id) = token(event.get("id")) else {
        return Ok(());
    };
    if !is_internal(event) {
        return Ok(());
    }
    db.execute(
        "INSERT OR IGNORE INTO app_internal_continuation_progress_events(turn_id,event_id) VALUES(?1,?2)",
        params![turn,event_id],
    ).map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(super) fn retain_marker(
    db: &Connection,
    turn: &str,
    payload: &Map<String, Value>,
    source_event_id: i64,
) -> Result<bool, AppStorageError> {
    let Some(event_id) = token(payload.get("event_id")) else {
        return Ok(false);
    };
    let found = db.query_row(
        "SELECT 1 FROM app_internal_continuation_progress_events WHERE turn_id=?1 AND event_id=?2",
        params![turn,event_id], |_|Ok(())
    ).optional().map_err(AppStorageError::sqlite)?.is_some();
    if !found {
        return Ok(false);
    }
    db.execute(
        "UPDATE app_internal_continuation_progress_events SET source_event_id=?1 WHERE turn_id=?2 AND event_id=?3",
        params![source_event_id,turn,event_id],
    ).map_err(AppStorageError::sqlite)?;
    db.execute(
        "INSERT OR REPLACE INTO app_terminal_turn_progress_rows(turn_id,source_event_id,row_json) VALUES(?1,?2,?3)",
        params![turn,source_event_id,json!({
            "id":format!("internal-continuation-{source_event_id}"),
            "kind":"thinking","safe_label":"Internal continuation","state":"running"
        }).to_string()],
    ).map_err(AppStorageError::sqlite)?;
    Ok(true)
}

pub(super) fn clear_batch(db: &Connection, turn: &str) -> Result<bool, AppStorageError> {
    db.execute(&format!(
        "DELETE FROM app_terminal_turn_progress_rows WHERE turn_id=?1 AND source_event_id IN (SELECT source_event_id FROM app_internal_continuation_progress_events WHERE turn_id=?1 LIMIT {DELETE_BATCH})"
    ),[turn]).map_err(AppStorageError::sqlite)?;
    db.execute(&format!(
        "DELETE FROM app_internal_continuation_progress_events WHERE turn_id=?1 AND event_id IN (SELECT event_id FROM app_internal_continuation_progress_events WHERE turn_id=?1 LIMIT {DELETE_BATCH})"
    ),[turn]).map_err(AppStorageError::sqlite)?;
    db.query_row(
        "SELECT 1 FROM app_internal_continuation_progress_events WHERE turn_id=?1 LIMIT 1",
        [turn],
        |_| Ok(()),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(AppStorageError::sqlite)
}

fn is_internal(event: &Map<String, Value>) -> bool {
    if event.get("kind").and_then(Value::as_str) != Some("tool.progress") {
        return false;
    }
    let Some(payload) = event.get("payload").and_then(Value::as_object) else {
        return false;
    };
    token(payload.get("activityKind")).as_deref() == Some("model")
        && boolean_like(payload.get("noVisibleReply"))
        && [
            "continuationRequeued",
            "continuation_requeued",
            "recoveryRequeued",
            "recovery_requeued",
        ]
        .iter()
        .any(|key| boolean_like(payload.get(*key)))
}

fn boolean_like(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(true)) => true,
        Some(Value::Number(number)) => number.as_i64() == Some(1),
        Some(Value::String(value)) => matches!(value.as_str(), "true" | "1"),
        _ => false,
    }
}

fn token(value: Option<&Value>) -> Option<String> {
    let text = value
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)?;
    if text.is_empty()
        || !text
            .chars()
            .all(|character| character.is_alphanumeric() || "_:./-".contains(character))
    {
        return None;
    }
    Some(text.chars().take(96).collect())
}
