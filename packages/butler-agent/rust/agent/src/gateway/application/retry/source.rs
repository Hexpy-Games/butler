//! Canonical retry eligibility and source-message snapshots.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::{AppStorageError, execution_controls_error, not_retryable_error, queue_snapshot_error};
use crate::{
    btcc::{ControlResolution, ExecutionControls, VerifiedExecutionControls},
    public_text::sanitize_public_text,
};

pub(super) struct RetrySnapshot {
    pub turn_id: String,
    pub chat_id: String,
    pub user_message_id: String,
    pub text: String,
    pub attempt: u64,
    pub execution_controls_json: String,
    pub control_resolution_json: String,
    pub controls_json: String,
    pub attachments_json: String,
    pub content_parts_json: Option<String>,
    pub project_source_refs_json: String,
    pub input_identity_digest: String,
}

pub(super) struct CurrentControlsRetrySource {
    pub chat_id: String,
    pub user_message_id: String,
    pub text: String,
    pub attachment_ids: Vec<String>,
}

pub(super) fn retry_snapshot(
    db: &Connection,
    turn_id: &str,
) -> Result<RetrySnapshot, AppStorageError> {
    let turn = db
        .query_row(
            "SELECT chat_id,user_message_id,state,retryable,attempt,execution_controls_json \
             FROM turns WHERE id=?1",
            [turn_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, u64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(|| AppStorageError::new("turn_not_found", "Turn not found."))?;
    if turn.2 != "runtime_fault" || turn.3 != 1 || !runtime_fault_retryable(db, turn_id)? {
        return Err(not_retryable_error());
    }
    let user_message_id = turn.1.ok_or_else(|| {
        AppStorageError::new("turn_missing_user_message", "Turn cannot be retried.")
    })?;
    let (message_chat, message_turn, role, text): (String, Option<String>, String, String) = db
        .query_row(
            "SELECT chat_id,turn_id,role,text FROM messages WHERE id=?1",
            [&user_message_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(|| {
            AppStorageError::new("turn_missing_user_message", "Turn cannot be retried.")
        })?;
    if message_chat != turn.0 || message_turn.as_deref() != Some(turn_id) || role != "user" {
        return Err(AppStorageError::new(
            "turn_missing_user_message",
            "Turn cannot be retried.",
        ));
    }
    let queue = db
        .query_row(
            "SELECT text,input_identity_digest,control_resolution_json,controls_json,\
             attachments_json,content_parts_json,project_source_refs_json,\
             dispatched_message_id,state FROM session_queued_messages \
             WHERE chat_id=?1 AND turn_id=?2 ORDER BY rowid DESC LIMIT 1",
            params![turn.0, turn_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(queue_snapshot_error)?;
    if queue.0 != text
        || queue.7.as_deref() != Some(user_message_id.as_str())
        || queue.8 == "dispatching"
    {
        return Err(queue_snapshot_error());
    }
    let control_resolution_json = queue.2.ok_or_else(queue_snapshot_error)?;
    let controls_json = queue.3;
    let attachments: Value = serde_json::from_str(&queue.4).map_err(|_| queue_snapshot_error())?;
    if !attachments.is_array() {
        return Err(queue_snapshot_error());
    }
    let project_source_refs: Value =
        serde_json::from_str(&queue.6).map_err(|_| queue_snapshot_error())?;
    if !project_source_refs.is_array() {
        return Err(queue_snapshot_error());
    }
    let execution_controls_json = turn.5.ok_or_else(execution_controls_error)?;
    let input_identity_digest = queue
        .1
        .unwrap_or_else(|| format!("retry:{turn_id}:{}", turn.4.saturating_add(1)));
    Ok(RetrySnapshot {
        turn_id: turn_id.to_owned(),
        chat_id: turn.0,
        user_message_id,
        text,
        attempt: turn.4,
        execution_controls_json,
        control_resolution_json,
        controls_json,
        attachments_json: queue.4,
        content_parts_json: queue.5,
        project_source_refs_json: queue.6,
        input_identity_digest,
    })
}

pub(super) fn verified_execution_controls(
    snapshot: &RetrySnapshot,
) -> Result<(VerifiedExecutionControls, ControlResolution), AppStorageError> {
    let execution_controls: ExecutionControls =
        serde_json::from_str(&snapshot.execution_controls_json)
            .map_err(|_| execution_controls_error())?;
    let verified = execution_controls
        .verify()
        .map_err(|_| execution_controls_error())?;
    if verified.turn_id != snapshot.turn_id || verified.session_id != snapshot.chat_id {
        return Err(execution_controls_error());
    }
    let controls = super::settings::resolution_from_persisted(&snapshot.control_resolution_json)
        .map_err(|_| queue_snapshot_error())?;
    Ok((verified, controls))
}

pub(super) fn current_controls_retry_source(
    db: &Connection,
    turn_id: &str,
) -> Result<CurrentControlsRetrySource, AppStorageError> {
    let (chat_id, user_message_id, state, retryable): (String, Option<String>, String, i64) = db
        .query_row(
            "SELECT chat_id,user_message_id,state,retryable FROM turns WHERE id=?1",
            [turn_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(|| AppStorageError::new("turn_not_found", "Turn not found."))?;
    if state != "runtime_fault" || retryable != 1 || !runtime_fault_retryable(db, turn_id)? {
        return Err(not_retryable_error());
    }
    let user_message_id = user_message_id.ok_or_else(|| {
        AppStorageError::new("turn_missing_user_message", "Turn cannot be retried.")
    })?;
    let (message_chat, message_turn, role, text): (String, Option<String>, String, String) = db
        .query_row(
            "SELECT chat_id,turn_id,role,text FROM messages WHERE id=?1",
            [&user_message_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(|| {
            AppStorageError::new("turn_missing_user_message", "Turn cannot be retried.")
        })?;
    if message_chat != chat_id || message_turn.as_deref() != Some(turn_id) || role != "user" {
        return Err(AppStorageError::new(
            "turn_missing_user_message",
            "Turn cannot be retried.",
        ));
    }
    let mut statement = db
        .prepare(
            "SELECT a.file_id FROM message_attachments a JOIN message_files f ON f.id=a.file_id \
             WHERE a.message_id=?1 ORDER BY a.position",
        )
        .map_err(AppStorageError::sqlite)?;
    let attachment_ids = statement
        .query_map([&user_message_id], |row| row.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    Ok(CurrentControlsRetrySource {
        chat_id,
        user_message_id,
        text,
        attachment_ids,
    })
}

fn runtime_fault_retryable(db: &Connection, turn_id: &str) -> Result<bool, AppStorageError> {
    let payload_json = db
        .query_row(
            "SELECT payload_json FROM events WHERE type='agent.turn_event' AND turn_id=?1 \
             AND json_extract(payload_json,'$.event.kind')='runtime.fault' \
             ORDER BY id DESC LIMIT 1",
            [turn_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let Some(payload_json) = payload_json else {
        return Ok(false);
    };
    let Ok(value) = serde_json::from_str::<Value>(&payload_json) else {
        return Ok(false);
    };
    let Some(fault) = value
        .get("event")
        .and_then(|event| event.get("payload"))
        .and_then(Value::as_object)
    else {
        return Ok(false);
    };
    let has_safe_identity = ["faultId", "kind", "publicSummary"].iter().all(|key| {
        fault
            .get(*key)
            .and_then(Value::as_str)
            .map(|value| sanitize_public_text(value, ""))
            .is_some_and(|value| !value.is_empty())
    });
    Ok(has_safe_identity && fault.get("retryable").and_then(Value::as_bool) == Some(true))
}
