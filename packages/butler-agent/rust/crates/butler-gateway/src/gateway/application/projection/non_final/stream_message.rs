//! The provisional assistant message of a streaming turn: `message.updated`
//! with status `streaming` under one id per uninterrupted segment, which the
//! final answer later reuses (`message.created` with the same id).
//!
//! The message shows one provider stream at a time (`turn_stream_drafts`):
//! deltas of the current stream are appended, the first delta of a new stream
//! (the next model round) replaces the text. A stream the runtime discards
//! (`model.stream.completed` with status `discarded`: its round called tools,
//! or its answer candidate was sent back) stays visible until the next stream
//! replaces it, but it is never kept as a stopped turn's partial answer.

use crate::gateway::application::storage::CachedSql;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::gateway::application::{
    events::{self, EventSubscribers},
    read_model, service,
    storage::AppStorageError,
};

/// The draft a projected runtime event changes.
enum StreamEvent<'a> {
    Delta { stream: &'a str, text: &'a str },
    Discarded { stream: &'a str, rejected: bool },
}

fn stream_event<'a>(kind: &str, payload: &'a Map<String, Value>) -> Option<StreamEvent<'a>> {
    let stream = payload.get("streamId").and_then(Value::as_str)?;
    match kind {
        "model.stream.text_delta"
            if payload.get("target").and_then(Value::as_str) == Some("final_candidate") =>
        {
            let text = payload
                .get("textDelta")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())?;
            Some(StreamEvent::Delta { stream, text })
        }
        "model.stream.completed"
            if payload.get("status").and_then(Value::as_str) == Some("discarded") =>
        {
            Some(StreamEvent::Discarded {
                stream,
                rejected: payload.get("reason").and_then(Value::as_str) == Some("answer_rejected"),
            })
        }
        _ => None,
    }
}

/// Where a projected stream event lands.
struct StreamTarget<'a> {
    db: &'a Connection,
    subscribers: &'a EventSubscribers,
    chat: &'a str,
    turn: &'a str,
    now: &'a str,
}

/// Projects a public `model.stream.*` runtime event onto the turn's
/// provisional message; other events are ignored.
pub(super) fn project(
    input: &super::RuntimeInput<'_>,
    kind: &str,
    payload: &Map<String, Value>,
) -> Result<(), AppStorageError> {
    let target = StreamTarget {
        db: input.db,
        subscribers: input.subscribers,
        chat: input.chat,
        turn: input.turn,
        now: input.now,
    };
    match stream_event(kind, payload) {
        Some(StreamEvent::Delta { stream, text }) => append(&target, stream, text),
        Some(StreamEvent::Discarded { stream, rejected }) => discard(&target, stream, rejected),
        None => Ok(()),
    }
}

/// Appends `delta` to the turn's provisional message, creating it on the
/// first delta and replacing its text when a new stream starts. Deltas after
/// the turn settled or its answer was stored are ignored.
fn append(target: &StreamTarget<'_>, stream: &str, delta: &str) -> Result<(), AppStorageError> {
    let StreamTarget {
        db,
        chat,
        turn,
        now,
        ..
    } = *target;
    // A delta-only operation cannot settle the turn. Retain every published
    // update in its cache and persist the final row before committing.
    if let Some(mut message) = super::batch::stream_message(chat, turn) {
        if super::batch::stream(turn).as_deref() == Some(stream) {
            message.text.push_str(delta);
        } else {
            message.text = delta.to_owned();
        }
        message.updated_at = now.to_owned();
        super::batch::remember(&message);
        super::batch::remember_stream(turn, stream);
        return updated(target, &message.id, false);
    }
    if !open(db, turn)? {
        return Ok(());
    }
    let continues =
        draft(db, turn)?.is_some_and(|(current, discarded)| current == stream && !discarded);
    db.execute_cached(
        "INSERT INTO turn_stream_drafts(turn_id,stream_id,discarded,updated_at) VALUES(?1,?2,0,?3) \
         ON CONFLICT(turn_id) DO UPDATE SET stream_id=excluded.stream_id,discarded=0,\
         updated_at=excluded.updated_at",
        params![turn, stream, now],
    )
    .map_err(AppStorageError::sqlite)?;
    let id = match latest(db, chat, turn)? {
        Some((id, status)) if status == "streaming" => {
            let sql = if continues {
                "UPDATE messages SET text=text||?1,updated_at=?2 WHERE id=?3"
            } else {
                "UPDATE messages SET text=?1,updated_at=?2 WHERE id=?3"
            };
            db.execute_cached(sql, params![delta, now, id])
                .map_err(AppStorageError::sqlite)?;
            id
        }
        Some(_) => return Ok(()),
        None => {
            let id = format!("message-{}", uuid::Uuid::new_v4());
            db.execute_cached(
                "INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at,retryable) \
                 VALUES(?1,?2,?3,'assistant',?4,'streaming',?5,?5,0)",
                params![id, chat, turn, delta, now],
            )
            .map_err(AppStorageError::sqlite)?;
            id
        }
    };
    super::batch::remember_stream(turn, stream);
    updated(target, &id, false)
}

/// Marks `stream` as not the answer, when it is the turn's current stream.
fn discard(target: &StreamTarget<'_>, stream: &str, rejected: bool) -> Result<(), AppStorageError> {
    target
        .db
        .execute_cached(
            "UPDATE turn_stream_drafts SET discarded=1,updated_at=?1 \
             WHERE turn_id=?2 AND stream_id=?3",
            params![target.now, target.turn, stream],
        )
        .map_err(AppStorageError::sqlite)?;
    if rejected {
        clear_rejected(target, stream)?;
    }
    Ok(())
}

fn clear_rejected(target: &StreamTarget<'_>, stream: &str) -> Result<(), AppStorageError> {
    if draft(target.db, target.turn)?.is_none_or(|(current, _)| current != stream) {
        return Ok(());
    }
    let Some((id, status)) = latest(target.db, target.chat, target.turn)? else {
        return Ok(());
    };
    if status == "streaming" {
        target
            .db
            .execute_cached(
                "UPDATE messages SET text='',updated_at=?1 WHERE id=?2",
                params![target.now, id],
            )
            .map_err(AppStorageError::sqlite)?;
        updated(target, &id, false)?;
    }
    Ok(())
}

/// Keeps a stopped turn's streamed answer text as a cancelled message. Text
/// of a discarded stream (a tool round or a rejected candidate) is not an
/// answer: that provisional message is removed instead.
pub(super) fn stop(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat: &str,
    turn: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    let target = StreamTarget {
        db,
        subscribers,
        chat,
        turn,
        now,
    };
    let Some((id, status)) = latest(db, chat, turn)? else {
        return Ok(());
    };
    if status != "streaming" {
        return Ok(());
    }
    // A provisional message from before stream drafts existed has no draft.
    let answer = draft(db, turn)?.is_none_or(|(_, discarded)| !discarded);
    db.execute_cached("DELETE FROM turn_stream_drafts WHERE turn_id=?1", [turn])
        .map_err(AppStorageError::sqlite)?;
    if answer {
        db.execute_cached(
            "UPDATE messages SET status='cancelled',safe_error_code='turn_stopped',updated_at=?1 \
             WHERE id=?2",
            params![now, id],
        )
        .map_err(AppStorageError::sqlite)?;
        return updated(&target, &id, false);
    }
    db.execute_cached("DELETE FROM messages WHERE id=?1", [&id])
        .map_err(AppStorageError::sqlite)?;
    events::append(
        db,
        subscribers,
        "message.deleted",
        Some(turn),
        service::map(&json!({"message_id":id,"chat_id":chat,"turn_id":turn,"role":"assistant"}))?,
        now,
    )?;
    Ok(())
}

/// Freezes text already shown before suspension, including questions and
/// approvals. A resumed turn starts a new provisional message; it cannot
/// overwrite the segment the principal read before making their decision.
pub(super) fn settle_suspended(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat: &str,
    turn: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    let target = StreamTarget {
        db,
        subscribers,
        chat,
        turn,
        now,
    };
    let (id, status) = match latest(db, chat, turn)? {
        Some(message) => message,
        None => {
            // Tool-only questions and delegation still own an assistant segment
            // for their activity and the public question/delegation card.
            let id = format!("message-{}", uuid::Uuid::new_v4());
            db.execute(
                "INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at,retryable) \
                 VALUES(?1,?2,?3,'assistant','','streaming',?4,?4,0)",
                params![id, chat, turn, now],
            ).map_err(AppStorageError::sqlite)?;
            (id, "streaming".into())
        }
    };
    if status != "streaming" {
        return Ok(());
    }
    db.execute_cached("DELETE FROM turn_stream_drafts WHERE turn_id=?1", [turn])
        .map_err(AppStorageError::sqlite)?;
    db.execute_cached(
        "UPDATE messages SET status='delivered',updated_at=?1 WHERE id=?2",
        params![now, id],
    )
    .map_err(AppStorageError::sqlite)?;
    updated(&target, &id, true)
}

/// Marks the turn's provisional message failed when the turn ended without a
/// visible answer (`code` is the turn's error code).
pub(in crate::gateway::application::projection) fn fail_unanswered(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat: &str,
    turn: &str,
    code: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    let target = StreamTarget {
        db,
        subscribers,
        chat,
        turn,
        now,
    };
    let Some((id, status)) = latest(db, chat, turn)? else {
        return Ok(());
    };
    if status != "streaming" {
        return Ok(());
    }
    db.execute_cached("DELETE FROM turn_stream_drafts WHERE turn_id=?1", [turn])
        .map_err(AppStorageError::sqlite)?;
    db.execute_cached(
        "UPDATE messages SET status='failed',safe_error_code=?1,updated_at=?2 WHERE id=?3",
        params![code, now, id],
    )
    .map_err(AppStorageError::sqlite)?;
    updated(&target, &id, false)
}

fn open(db: &Connection, turn: &str) -> Result<bool, AppStorageError> {
    Ok(db
        .query_row_cached(
            "SELECT 1 FROM turns WHERE id=?1 AND state IN \
             ('accepted','thinking','streaming','waiting_for_form','waiting_for_tool','retrying','cancelling')",
            [turn],
            |_| Ok(true),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .unwrap_or(false))
}

/// The turn's current stream and whether it was discarded.
fn draft(db: &Connection, turn: &str) -> Result<Option<(String, bool)>, AppStorageError> {
    db.query_row_cached(
        "SELECT stream_id,discarded FROM turn_stream_drafts WHERE turn_id=?1",
        [turn],
        |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}

/// The turn's latest assistant message and its status.
fn latest(
    db: &Connection,
    chat: &str,
    turn: &str,
) -> Result<Option<(String, String)>, AppStorageError> {
    db.query_row_cached(
        "SELECT id,status FROM messages WHERE chat_id=?1 AND turn_id=?2 AND role='assistant' AND status<>'delivered' \
         ORDER BY rowid DESC LIMIT 1",
        params![chat, turn],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}

fn updated(
    target: &StreamTarget<'_>,
    id: &str,
    segment_completed: bool,
) -> Result<(), AppStorageError> {
    let message = if let Some(message) = super::batch::message(id) {
        // This operation contains only stream deltas: attachments, identity,
        // status and terminal decorations cannot change between these rows.
        message
    } else {
        let streaming = if super::batch::active() {
            read_model::streaming_message(target.db, target.chat, target.turn, id)?
        } else {
            None
        };
        let message = match streaming {
            Some(message) => message,
            None => {
                let Some(message) = read_model::list_messages(target.db, target.chat, 0.0, 200)?
                    .messages
                    .into_iter()
                    .find(|message| message.id == id)
                else {
                    return Ok(());
                };
                message
            }
        };
        super::batch::remember(&message);
        message
    };
    events::append(
        target.db,
        target.subscribers,
        "message.updated",
        Some(target.turn),
        service::map(&json!({"message": message, "segment_completed": segment_completed}))?,
        target.now,
    )?;
    Ok(())
}
