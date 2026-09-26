//! Claim-fenced projection of delivered App transport events before final-result handling.

mod operations;
mod progress;
mod runtime_progress;
mod runtime_values;
mod values;

use operations::*;
use progress::*;
use runtime_progress::*;
use runtime_values::*;
use values::*;

use rusqlite::{Connection, params};
use serde_json::{Map, Value, json};

pub(in crate::gateway::application) fn normalize_committed_turn_event(
    kind: &str,
    visibility: &str,
    payload: Option<&Map<String, Value>>,
) -> Result<Map<String, Value>, super::super::storage::AppStorageError> {
    runtime_values::prepare_runtime_payload(kind, visibility, payload)
}

use super::{TranscriptEvent, checkpoint, staging};
use crate::gateway::application::{
    MaterializedResponderFile,
    events::{self, EventSubscribers},
    internal_continuation,
    queue::{self, QueuedTurnClaimStatus},
    service,
    storage::AppStorageError,
};

pub(super) struct ProjectionIds {
    pub event_id: String,
    pub message_id: String,
}

pub(super) struct ProjectionOutcome {
    pub handled: bool,
    pub wake_queue: bool,
    pub terminal_turn: Option<String>,
}
pub(super) struct ApplyInput<'a> {
    pub chat_id: &'a str,
    pub action_id: &'a str,
    pub outbound: &'a TranscriptEvent,
    pub cursor: &'a checkpoint::Checkpoint,
    pub now: &'a str,
    pub subscribers: &'a EventSubscribers,
    pub ids: ProjectionIds,
    pub worker_files: Vec<MaterializedResponderFile>,
}

pub(super) fn apply(
    db: &mut Connection,
    input: ApplyInput<'_>,
) -> Result<ProjectionOutcome, AppStorageError> {
    if worker_result(object(input.outbound.payload.get("metadata"))) {
        return project_worker_result(db, input);
    }
    let ApplyInput {
        chat_id,
        action_id,
        outbound,
        cursor,
        now,
        subscribers,
        ids,
        worker_files: _,
    } = input;
    let message = object(outbound.payload.get("message"));
    let metadata = object(outbound.payload.get("metadata"));
    let Some(turn_id) = turn_id(db, chat_id, metadata, message)? else {
        return Ok(not_handled());
    };
    let kind = text(metadata.get("kind")).unwrap_or_default();
    let is_runtime_event =
        kind == "turn_event" && metadata.get("event").is_some_and(Value::is_object);
    let is_progress = matches!(
        kind.as_str(),
        "tool_progress" | "todo_progress" | "intermediate"
    );
    let handled_kind = is_runtime_event
        || is_progress
        || matches!(
            kind.as_str(),
            "turn_cancelled" | "turn_failed" | "turn_cancellation_ack" | "turn_suspended"
        );
    if !handled_kind {
        return Ok(not_handled());
    }
    let claim_id = token(metadata.get("appQueueClaimId"));
    let tx = db.transaction().map_err(AppStorageError::sqlite)?;
    if staging::projected(&tx, action_id)? {
        staging::delete(&tx, action_id)?;
        checkpoint::save(&tx, cursor, now)?;
        tx.commit().map_err(AppStorageError::sqlite)?;
        return Ok(ProjectionOutcome {
            handled: true,
            wake_queue: false,
            terminal_turn: None,
        });
    }
    let claim_status = queue::claim_status(&tx, chat_id, &turn_id, claim_id.as_deref())?;
    if claim_status == QueuedTurnClaimStatus::Stale {
        checkpoint::save(&tx, cursor, now)?;
        tx.commit().map_err(AppStorageError::sqlite)?;
        return Ok(ProjectionOutcome {
            handled: true,
            wake_queue: false,
            terminal_turn: None,
        });
    }
    if claim_status == QueuedTurnClaimStatus::Terminal {
        finish(&tx, action_id, outbound, chat_id, cursor, now)?;
        tx.commit().map_err(AppStorageError::sqlite)?;
        return Ok(ProjectionOutcome {
            handled: true,
            wake_queue: false,
            terminal_turn: None,
        });
    }
    if claim_status == QueuedTurnClaimStatus::Current {
        let Some(claim) = claim_id.as_deref() else {
            checkpoint::save(&tx, cursor, now)?;
            tx.commit().map_err(AppStorageError::sqlite)?;
            return Ok(ProjectionOutcome {
                handled: true,
                wake_queue: false,
                terminal_turn: None,
            });
        };
        if !queue::fence(&tx, chat_id, &turn_id, claim)? {
            checkpoint::save(&tx, cursor, now)?;
            tx.commit().map_err(AppStorageError::sqlite)?;
            return Ok(ProjectionOutcome {
                handled: true,
                wake_queue: false,
                terminal_turn: None,
            });
        }
    }
    if kind == "turn_suspended" {
        let (terminal, wake_queue) = project_suspended(
            &tx,
            subscribers,
            chat_id,
            &turn_id,
            claim_id.as_deref(),
            metadata,
            now,
        )?;
        finish(&tx, action_id, outbound, chat_id, cursor, now)?;
        tx.execute(
            "UPDATE chats SET updated_at=?1 WHERE id=?2",
            params![now, chat_id],
        )
        .map_err(AppStorageError::sqlite)?;
        tx.commit().map_err(AppStorageError::sqlite)?;
        return Ok(ProjectionOutcome {
            handled: true,
            wake_queue,
            terminal_turn: terminal.then_some(turn_id),
        });
    }
    if matches!(
        kind.as_str(),
        "tool_progress" | "todo_progress" | "intermediate" | "turn_failed" | "turn_cancelled"
    ) && terminal_turn(&tx, &turn_id)?
    {
        finish(&tx, action_id, outbound, chat_id, cursor, now)?;
        tx.commit().map_err(AppStorageError::sqlite)?;
        return Ok(ProjectionOutcome {
            handled: true,
            wake_queue: false,
            terminal_turn: None,
        });
    }
    if kind == "turn_failed" && btcc_retains_authority(&tx, &turn_id)? {
        checkpoint::save(&tx, cursor, now)?;
        tx.commit().map_err(AppStorageError::sqlite)?;
        return Ok(ProjectionOutcome {
            handled: true,
            wake_queue: false,
            terminal_turn: None,
        });
    }
    let terminal = if is_runtime_event {
        project_runtime_event(RuntimeInput {
            db: &tx,
            subscribers,
            chat: chat_id,
            turn: &turn_id,
            metadata,
            message,
            now,
            generated_id: &ids.event_id,
        })?
        .map(str::to_owned)
    } else if is_progress {
        project_progress(ProgressInput {
            db: &tx,
            subscribers,
            chat: chat_id,
            turn: &turn_id,
            action: action_id,
            kind: &kind,
            metadata,
            message,
            timestamp: &outbound.timestamp,
            now,
            event_id: &ids.event_id,
        })?;
        None
    } else if kind == "turn_cancellation_ack" {
        project_cancellation_ack(&tx, &turn_id, metadata, &outbound.timestamp)?;
        None
    } else if kind == "turn_cancelled" {
        project_cancelled(
            &tx,
            subscribers,
            chat_id,
            &turn_id,
            metadata,
            now,
            &ids.event_id,
        )?;
        Some("turn_cancelled".to_owned())
    } else {
        project_failed(
            &tx,
            subscribers,
            chat_id,
            &turn_id,
            FailedProjection {
                metadata,
                message,
                retryable: false,
            },
            now,
            &ids,
        )?;
        Some(token(metadata.get("safeErrorCode")).unwrap_or_else(|| "gateway_failed".to_owned()))
    };
    let mut wake = false;
    if let Some(code) = terminal.as_deref() {
        wake = settle_if_claimed(
            &tx,
            subscribers,
            chat_id,
            &turn_id,
            claim_id.as_deref(),
            code,
            now,
        )?;
    }
    finish(&tx, action_id, outbound, chat_id, cursor, now)?;
    tx.execute(
        "UPDATE chats SET updated_at=?1 WHERE id=?2",
        params![now, chat_id],
    )
    .map_err(AppStorageError::sqlite)?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(ProjectionOutcome {
        handled: true,
        wake_queue: wake,
        terminal_turn: terminal.map(|_| turn_id),
    })
}

struct RuntimeInput<'a> {
    db: &'a Connection,
    subscribers: &'a EventSubscribers,
    chat: &'a str,
    turn: &'a str,
    metadata: &'a Map<String, Value>,
    message: &'a Map<String, Value>,
    now: &'a str,
    generated_id: &'a str,
}
fn project_runtime_event(input: RuntimeInput<'_>) -> Result<Option<&'static str>, AppStorageError> {
    let RuntimeInput {
        db,
        subscribers,
        chat,
        turn,
        metadata,
        message,
        now,
        generated_id,
    } = input;
    let source = object(metadata.get("event"));
    let Some(kind) = token(source.get("kind")) else {
        return Ok(None);
    };
    if kind == "operation.output.chunk" {
        operation_output(db, turn, object(source.get("payload")), now)?;
        return Ok(None);
    }
    let visibility = if source.get("visibility").and_then(Value::as_str) == Some("internal") {
        "internal"
    } else {
        "public"
    };
    let normalized_payload = prepare_runtime_payload(
        &kind,
        visibility,
        source.get("payload").and_then(Value::as_object),
    )?;
    internal_continuation::remember(db, turn, source)?;
    if visibility != "internal" {
        let mut event = source.clone();
        let actual_event_id = token(event.get("id")).unwrap_or_else(|| generated_id.to_owned());
        event.insert("id".into(), actual_event_id.clone().into());
        event.insert("sessionId".into(), chat.into());
        event.insert("turnId".into(), turn.into());
        let session_next = next_sequence(db, "sessionId", chat)?;
        let turn_next = next_sequence(db, "turnId", turn)?;
        event.insert(
            "sessionSequence".into(),
            sequence(event.get("sessionSequence"), session_next).into(),
        );
        event.insert(
            "turnSequence".into(),
            sequence(event.get("turnSequence"), turn_next).into(),
        );
        event.entry("visibility").or_insert_with(|| "public".into());
        event.insert("payload".into(), Value::Object(normalized_payload));
        event
            .entry("createdAt")
            .or_insert_with(|| Value::String(now.to_owned()));
        let progress_row = row_from_runtime_event(
            &kind,
            object(event.get("payload")),
            &actual_event_id,
            now,
            event.get("turnSequence").and_then(Value::as_u64),
        );
        events::append(
            db,
            subscribers,
            "agent.turn_event",
            Some(turn),
            service::map(json!({
                "session_id": chat, "turn_id": turn, "event": event
            }))?,
            now,
        )?;
        if let Some(row) = progress_row {
            append_progress(ProgressAppend {
                db,
                subscribers,
                chat,
                turn,
                row,
                event_type: "agent.turn_event.progress",
                source_event: Some(&actual_event_id),
                now,
            })?;
        }
    }
    if kind == "runtime.fault" {
        let payload = object(source.get("payload"));
        let mut fault_meta = metadata.clone();
        fault_meta.insert("safeErrorCode".into(), "runtime_fault".into());
        let mut fault_message = message.clone();
        if let Some(summary) = payload.get("publicSummary") {
            fault_message.insert("text".into(), summary.clone());
        }
        project_failed(
            db,
            subscribers,
            chat,
            turn,
            FailedProjection {
                metadata: &fault_meta,
                message: &fault_message,
                retryable: payload.get("retryable").and_then(Value::as_bool) == Some(true),
            },
            now,
            &ProjectionIds {
                event_id: generated_id.to_owned(),
                message_id: format!("message-{generated_id}"),
            },
        )?;
        return Ok(Some("runtime_fault"));
    }
    if kind == "turn.cancelled" {
        project_cancelled(db, subscribers, chat, turn, metadata, now, generated_id)?;
        return Ok(Some("turn_cancelled"));
    }
    Ok(None)
}

pub(super) fn finish(
    db: &Connection,
    action: &str,
    event: &TranscriptEvent,
    chat: &str,
    cursor: &checkpoint::Checkpoint,
    now: &str,
) -> Result<(), AppStorageError> {
    staging::delete(db, action)?;
    staging::mark(db, action, &event.event_id, chat, now)?;
    checkpoint::save(db, cursor, now)
}
