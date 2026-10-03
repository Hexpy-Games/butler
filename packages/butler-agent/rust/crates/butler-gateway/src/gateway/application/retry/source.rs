//! Canonical retry eligibility and source-message snapshots.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::{AppStorageError, execution_controls_error, not_retryable_error, queue_snapshot_error};
use crate::gateway::application::storage::AppStorageCode;
use butler_core::public_text::sanitize_public_text;
use butler_turn::btcc::{
    ControlResolution, ExecutionControls, SubsessionResultContext, VerifiedExecutionControls,
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

/// The queue row a retry dispatches: the turn's snapshotted input under a
/// client id of the next attempt.
pub(super) fn reservation(
    snapshot: &RetrySnapshot,
    queue_id: &str,
    now: &str,
) -> crate::gateway::application::queue::QueueReservation {
    crate::gateway::application::queue::QueueReservation {
        id: queue_id.to_owned(),
        chat_id: snapshot.chat_id.clone(),
        text: snapshot.text.clone(),
        client_message_id: format!(
            "retry-{}-{}",
            snapshot.turn_id,
            snapshot.attempt.saturating_add(1)
        ),
        input_identity_digest: snapshot.input_identity_digest.clone(),
        control_resolution_json: snapshot.control_resolution_json.clone(),
        controls_json: snapshot.controls_json.clone(),
        attachments_json: snapshot.attachments_json.clone(),
        content_parts_json: snapshot.content_parts_json.clone(),
        project_source_refs_json: snapshot.project_source_refs_json.clone(),
        created_at: now.to_owned(),
    }
}

pub(super) struct CurrentControlsRetrySource {
    pub chat_id: String,
    pub user_message_id: String,
    pub text: String,
    pub attachment_ids: Vec<String>,
    /// Set when the source turn reports a steward result: the fresh turn is
    /// model input too and must stay off the chat.
    pub subsession_result: Option<SubsessionResultContext>,
}

pub(super) fn retry_snapshot(
    db: &Connection,
    turn_id: &str,
) -> Result<RetrySnapshot, AppStorageError> {
    let turn = db
        .query_row(
            "SELECT chat_id,user_message_id,state,retryable,attempt,execution_controls_json,\
             safe_error_code FROM turns WHERE id=?1",
            [turn_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, u64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(|| AppStorageError::new(AppStorageCode::TurnNotFound, "Turn not found."))?;
    ensure_retryable(db, turn_id, &turn.2, turn.3, turn.6.as_deref())?;
    let user_message_id = turn.1.ok_or_else(|| {
        AppStorageError::new(
            AppStorageCode::TurnMissingUserMessage,
            "Turn cannot be retried.",
        )
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
            AppStorageError::new(
                AppStorageCode::TurnMissingUserMessage,
                "Turn cannot be retried.",
            )
        })?;
    if message_chat != turn.0 || message_turn.as_deref() != Some(turn_id) || role != "user" {
        return Err(AppStorageError::new(
            AppStorageCode::TurnMissingUserMessage,
            "Turn cannot be retried.",
        ));
    }
    let queue = db
        .query_row(
            "SELECT text,input_identity_digest,control_resolution_json,controls_json,\
             attachments_json,content_parts_json,project_source_refs_json,\
             dispatched_message_id,state FROM session_queued_messages \
             WHERE chat_id=?1 AND turn_id=?2 AND dispatched_message_id=?3 ORDER BY rowid DESC LIMIT 1",
            params![turn.0, turn_id, user_message_id],
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
    let attachments: Value = serde_json::from_str(&queue.4)
        .map_err(|source| queue_snapshot_error().with_source(source))?;
    if !attachments.is_array() {
        return Err(queue_snapshot_error());
    }
    let project_source_refs: Value = serde_json::from_str(&queue.6)
        .map_err(|source| queue_snapshot_error().with_source(source))?;
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
            .map_err(|source| execution_controls_error().with_source(source))?;
    let verified = execution_controls
        .verify()
        .map_err(|source| execution_controls_error().with_source(source))?;
    if verified.turn_id != snapshot.turn_id || verified.session_id != snapshot.chat_id {
        return Err(execution_controls_error());
    }
    let controls = super::settings::resolution_from_persisted(&snapshot.control_resolution_json)
        .map_err(|source| queue_snapshot_error().with_source(source))?;
    Ok((verified, controls))
}

pub(super) fn current_controls_retry_source(
    db: &Connection,
    turn_id: &str,
) -> Result<CurrentControlsRetrySource, AppStorageError> {
    let (chat_id, user_message_id, state, retryable_flag, code): (
        String,
        Option<String>,
        String,
        i64,
        Option<String>,
    ) = db
        .query_row(
            "SELECT chat_id,user_message_id,state,retryable,safe_error_code FROM turns WHERE id=?1",
            [turn_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(|| AppStorageError::new(AppStorageCode::TurnNotFound, "Turn not found."))?;
    ensure_retryable(db, turn_id, &state, retryable_flag, code.as_deref())?;
    ensure_fresh_retry_allowed(code.as_deref())?;
    let user_message_id = user_message_id.ok_or_else(|| {
        AppStorageError::new(
            AppStorageCode::TurnMissingUserMessage,
            "Turn cannot be retried.",
        )
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
            AppStorageError::new(
                AppStorageCode::TurnMissingUserMessage,
                "Turn cannot be retried.",
            )
        })?;
    if message_chat != chat_id || message_turn.as_deref() != Some(turn_id) || role != "user" {
        return Err(AppStorageError::new(
            AppStorageCode::TurnMissingUserMessage,
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
        subsession_result: source_subsession_result(db, turn_id)?,
    })
}

fn source_subsession_result(
    db: &Connection,
    turn_id: &str,
) -> Result<Option<SubsessionResultContext>, AppStorageError> {
    let marker: Option<String> = db
        .query_row(
            "SELECT CASE WHEN json_valid(execution_controls_json) \
             THEN json_extract(execution_controls_json,'$.subsession_result') END \
             FROM turns WHERE id=?1",
            [turn_id],
            |row| row.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    marker
        .map(|json| serde_json::from_str(&json))
        .transpose()
        .map_err(|source| execution_controls_error().with_source(source))
}

/// Refuses all but a retryable runtime fault or a turn interrupted by a
/// service crash.
fn ensure_retryable(
    db: &Connection,
    turn_id: &str,
    state: &str,
    retryable: i64,
    safe_error_code: Option<&str>,
) -> Result<(), AppStorageError> {
    let allowed = retryable == 1
        && match state {
            "runtime_fault" => runtime_fault_retryable(db, turn_id)?,
            "failed" => safe_error_code == Some(super::INTERRUPTED_TURN_CODE),
            _ => false,
        };
    if allowed {
        Ok(())
    } else {
        Err(not_retryable_error())
    }
}

/// `/retry-current` starts a fresh turn. A crash-interrupted turn may have run
/// tool effects that a fresh turn would run again, so only its resume
/// (`/retry`, which replays the recorded results) is offered.
fn ensure_fresh_retry_allowed(safe_error_code: Option<&str>) -> Result<(), AppStorageError> {
    if safe_error_code == Some(super::INTERRUPTED_TURN_CODE) {
        Err(not_retryable_error())
    } else {
        Ok(())
    }
}

/// `turn_id<>''` makes the partial `events_turn_id_idx` applicable.
pub(in crate::gateway::application) const RUNTIME_FAULT_SQL: &str = "SELECT payload_json \
    FROM events WHERE type='agent.turn_event' AND turn_id=?1 AND turn_id<>'' \
    AND json_extract(payload_json,'$.event.kind')='runtime.fault' ORDER BY id DESC LIMIT 1";

fn runtime_fault_retryable(db: &Connection, turn_id: &str) -> Result<bool, AppStorageError> {
    let payload_json = db
        .query_row(RUNTIME_FAULT_SQL, [turn_id], |row| row.get::<_, String>(0))
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
