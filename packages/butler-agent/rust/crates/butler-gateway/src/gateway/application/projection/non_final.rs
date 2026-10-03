//! Claim-fenced projection of delivered App transport events before final-result handling.

pub(super) mod batch;
mod operations;
mod progress;
mod runtime_event;
mod runtime_progress;
mod runtime_values;
mod stream_message;
pub(in crate::gateway::application::projection) use stream_message::fail_unanswered;
mod values;

use crate::gateway::application::storage::CachedSql;
use operations::*;
use progress::*;
pub(in crate::gateway::application) use runtime_progress::row_from_runtime_event;
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
    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    if staging::projected(&tx, action_id)? {
        return skip(tx, action_id, cursor, now);
    }
    let claim_status = current_claim_status(&tx, chat_id, &turn_id, claim_id.as_deref(), outbound)?;
    if claim_status == QueuedTurnClaimStatus::Stale {
        return skip(tx, action_id, cursor, now);
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
        let fenced = match claim_id.as_deref() {
            Some(claim) => queue::fence(&tx, chat_id, &turn_id, claim)?,
            None => false,
        };
        if !fenced {
            return skip(tx, action_id, cursor, now);
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
        tx.execute_cached(
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
        return skip(tx, action_id, cursor, now);
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
    tx.execute_cached(
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

#[derive(Clone, Copy)]
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
/// The status of `claim` for this outbound. The restarted App may have
/// recovered the claim of the crashed process before the restarted service
/// reported the interruption (turn_failed, turn_interrupted); the report
/// then restores and settles that same claim, so the message is not
/// dispatched again.
fn current_claim_status(
    db: &Connection,
    chat_id: &str,
    turn_id: &str,
    claim: Option<&str>,
    outbound: &TranscriptEvent,
) -> Result<QueuedTurnClaimStatus, AppStorageError> {
    let status = queue::claim_status(db, chat_id, turn_id, claim)?;
    let metadata = object(outbound.payload.get("metadata"));
    let reply_to = token(object(outbound.payload.get("message")).get("replyToMessageId"));
    if status == QueuedTurnClaimStatus::Stale
        && text(metadata.get("kind")).as_deref() == Some("turn_failed")
        && token(metadata.get("safeErrorCode")).as_deref()
            == Some(crate::gateway::application::retry::INTERRUPTED_TURN_CODE)
        && let (Some(claim), Some(reply_to)) = (claim, reply_to)
        && queue::restore_interrupted_claim(db, chat_id, turn_id, claim, &reply_to)?
    {
        return Ok(QueuedTurnClaimStatus::Current);
    }
    Ok(status)
}

fn project_runtime_event(input: RuntimeInput<'_>) -> Result<Option<&'static str>, AppStorageError> {
    let RuntimeInput {
        db,
        subscribers,
        chat,
        turn,
        metadata,
        now,
        generated_id,
        ..
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
        runtime_event::publish(input, source, &kind, normalized_payload)?;
    }
    if kind == "runtime.fault" {
        project_runtime_fault(input, object(source.get("payload")))?;
        return Ok(Some("runtime_fault"));
    }
    if kind == "turn.cancelled" {
        project_cancelled(db, subscribers, chat, turn, metadata, now, generated_id)?;
        return Ok(Some("turn_cancelled"));
    }
    Ok(None)
}

/// Projects a runtime fault event as a failed (runtime_fault) turn.
fn project_runtime_fault(
    input: RuntimeInput<'_>,
    payload: &Map<String, Value>,
) -> Result<(), AppStorageError> {
    let mut fault_meta = input.metadata.clone();
    fault_meta.insert("safeErrorCode".into(), "runtime_fault".into());
    let mut fault_message = input.message.clone();
    if let Some(summary) = payload.get("publicSummary") {
        fault_message.insert("text".into(), summary.clone());
    }
    project_failed(
        input.db,
        input.subscribers,
        input.chat,
        input.turn,
        FailedProjection {
            metadata: &fault_meta,
            message: &fault_message,
            retryable: payload.get("retryable").and_then(Value::as_bool) == Some(true),
        },
        input.now,
        &ProjectionIds {
            event_id: input.generated_id.to_owned(),
            message_id: format!("message-{}", input.generated_id),
        },
    )
}

/// Skips a delivery this projection does not apply (already projected, a
/// stale claim, a failed fence, a failure BTCC still owns) and retires its
/// staged outbound with it. The runtime writes every send of an action as a
/// new outbound record followed by its delivery, so no later delivery reads
/// this row: a later send stages its own record. A row left behind would
/// only turn such a send, when its payload differs (a claim it gained), into
/// an identity conflict that fails every later projection of the chat.
fn skip(
    tx: rusqlite::Savepoint<'_>,
    action: &str,
    cursor: &checkpoint::Checkpoint,
    now: &str,
) -> Result<ProjectionOutcome, AppStorageError> {
    staging::delete(&tx, action)?;
    checkpoint::save(&tx, cursor, now)?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(ProjectionOutcome {
        handled: true,
        wake_queue: false,
        terminal_turn: None,
    })
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
