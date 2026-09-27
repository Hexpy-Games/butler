//! The provisional assistant message of a streaming turn: `message.updated`
//! with the growing text and status `streaming` under one id, which the final
//! answer later reuses (`message.created` with the same id).

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::gateway::application::{
    events::{self, EventSubscribers},
    read_model, service,
    storage::AppStorageError,
};

/// The public text delta of a projected `model.stream.text_delta` event.
pub(super) fn final_text_delta<'a>(kind: &str, payload: &'a Map<String, Value>) -> Option<&'a str> {
    (kind == "model.stream.text_delta"
        && payload.get("target").and_then(Value::as_str) == Some("final_candidate"))
    .then(|| payload.get("textDelta").and_then(Value::as_str))
    .flatten()
    .filter(|text| !text.is_empty())
}

/// Appends `delta` to the turn's provisional message, creating it on the
/// first delta. Deltas after the turn settled or its answer was stored are
/// ignored.
pub(super) fn append(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat: &str,
    turn: &str,
    delta: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    let open: bool = db
        .query_row(
            "SELECT 1 FROM turns WHERE id=?1 AND state IN \
             ('accepted','thinking','streaming','waiting_for_tool','retrying','cancelling')",
            [turn],
            |_| Ok(true),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .unwrap_or(false);
    if !open {
        return Ok(());
    }
    let existing: Option<(String, String)> = db
        .query_row(
            "SELECT id,status FROM messages WHERE chat_id=?1 AND turn_id=?2 AND role='assistant' \
             ORDER BY rowid DESC LIMIT 1",
            params![chat, turn],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let id = match existing {
        Some((id, status)) if status == "streaming" => {
            db.execute(
                "UPDATE messages SET text=text||?1,updated_at=?2 WHERE id=?3",
                params![delta, now, id],
            )
            .map_err(AppStorageError::sqlite)?;
            id
        }
        Some(_) => return Ok(()),
        None => {
            let id = format!("message-stream-{turn}");
            db.execute(
                "INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at,retryable) \
                 VALUES(?1,?2,?3,'assistant',?4,'streaming',?5,?5,0)",
                params![id, chat, turn, delta, now],
            )
            .map_err(AppStorageError::sqlite)?;
            id
        }
    };
    updated(db, subscribers, chat, turn, &id, now)
}

/// Keeps a stopped turn's streamed text as a cancelled message.
pub(super) fn stop(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat: &str,
    turn: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    let streaming: Option<String> = db
        .query_row(
            "SELECT id FROM messages WHERE chat_id=?1 AND turn_id=?2 AND role='assistant' \
             AND status='streaming' ORDER BY rowid DESC LIMIT 1",
            params![chat, turn],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let Some(id) = streaming else {
        return Ok(());
    };
    db.execute(
        "UPDATE messages SET status='cancelled',safe_error_code='turn_stopped',updated_at=?1 \
         WHERE id=?2",
        params![now, id],
    )
    .map_err(AppStorageError::sqlite)?;
    updated(db, subscribers, chat, turn, &id, now)
}

fn updated(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat: &str,
    turn: &str,
    id: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    let Some(message) = read_model::list_messages(db, chat, 0.0, 200)?
        .messages
        .into_iter()
        .find(|row| row.id == id)
    else {
        return Ok(());
    };
    events::append(
        db,
        subscribers,
        "message.updated",
        Some(turn),
        service::map(&json!({"message": message}))?,
        now,
    )?;
    Ok(())
}
