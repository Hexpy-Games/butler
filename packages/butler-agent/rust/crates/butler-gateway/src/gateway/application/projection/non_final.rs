//! Claim-fenced projection of delivered App transport events before final-result handling.

pub(super) mod batch;
mod claim_status;
mod operations;
mod progress;
mod runtime_event;
mod runtime_progress;
mod runtime_values;
mod stream_message;
#[cfg(test)]
pub(in crate::gateway::application) mod terminal_tests;
mod transaction;
pub(in crate::gateway::application::projection) use stream_message::fail_unanswered;
mod values;

use crate::gateway::application::storage::CachedSql;
use claim_status::current_claim_status;
use operations::*;
pub(in crate::gateway::application) use operations::{
    FailedProjection, project_failed, settle_confirmed_stop,
};
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
    queue::QueuedTurnClaimStatus,
    service,
    storage::AppStorageError,
};

fn terminal_update_is_stale(
    db: &Connection,
    kind: &str,
    turn: &str,
) -> Result<bool, AppStorageError> {
    Ok(matches!(
        kind,
        "tool_progress"
            | "todo_progress"
            | "intermediate"
            | "turn_failed"
            | "turn_cancelled"
            | "turn_suspended"
    ) && terminal_turn(db, turn)?)
}

pub(in crate::gateway::application) struct ProjectionIds {
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

struct ResolvedInput<'a> {
    chat_id: &'a str,
    action_id: &'a str,
    outbound: &'a TranscriptEvent,
    cursor: &'a checkpoint::Checkpoint,
    now: &'a str,
    subscribers: &'a EventSubscribers,
    ids: ProjectionIds,
    metadata: &'a Map<String, Value>,
    message: &'a Map<String, Value>,
    turn_id: String,
    kind: String,
    claim_id: Option<String>,
    is_runtime_event: bool,
    is_progress: bool,
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
    apply_claimed(
        db,
        ResolvedInput {
            chat_id,
            action_id,
            outbound,
            cursor,
            now,
            subscribers,
            ids,
            metadata,
            message,
            turn_id,
            kind,
            claim_id: token(metadata.get("appQueueClaimId")),
            is_runtime_event,
            is_progress,
        },
    )
}

fn apply_claimed(
    db: &mut Connection,
    input: ResolvedInput<'_>,
) -> Result<ProjectionOutcome, AppStorageError> {
    let tx = transaction::Transaction::begin(db).map_err(AppStorageError::sqlite)?;
    if staging::projected(&tx, input.action_id)? {
        return skip(tx, input.action_id, input.cursor, input.now);
    }
    let claim_status = current_claim_status(
        &tx,
        input.chat_id,
        &input.turn_id,
        input.claim_id.as_deref(),
        input.outbound,
    )?;
    if claim_status == QueuedTurnClaimStatus::Stale {
        return skip(tx, input.action_id, input.cursor, input.now);
    }
    if claim_status == QueuedTurnClaimStatus::Terminal {
        return finish_terminal(tx, &input, no_terminal());
    }
    if claim_status == QueuedTurnClaimStatus::Current {
        let fenced = match input.claim_id.as_deref() {
            Some(claim) => batch::fence(&tx, input.chat_id, &input.turn_id, claim)?,
            None => false,
        };
        if !fenced {
            return skip(tx, input.action_id, input.cursor, input.now);
        }
    }
    // A resumed final result can arrive before the earlier suspension outbound.
    if terminal_update_is_stale(&tx, &input.kind, &input.turn_id)? {
        return finish_terminal(tx, &input, no_terminal());
    }
    if input.kind == "turn_suspended" {
        return apply_suspended(tx, &input);
    }
    if input.kind == "turn_failed" && terminal_authority_pending(&tx, &input.turn_id)? {
        return skip(tx, input.action_id, input.cursor, input.now);
    }
    apply_projection(tx, input)
}

fn apply_suspended(
    tx: transaction::Transaction<'_>,
    input: &ResolvedInput<'_>,
) -> Result<ProjectionOutcome, AppStorageError> {
    let (terminal, wake_queue) = project_suspended(
        &tx,
        input.subscribers,
        input.chat_id,
        &input.turn_id,
        input.claim_id.as_deref(),
        input.metadata,
        input.now,
    )?;
    finish(
        &tx,
        input.action_id,
        input.outbound,
        input.chat_id,
        input.cursor,
        input.now,
    )?;
    tx.execute_cached(
        "UPDATE chats SET updated_at=?1 WHERE id=?2",
        params![input.now, input.chat_id],
    )
    .map_err(AppStorageError::sqlite)?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(ProjectionOutcome {
        handled: true,
        wake_queue,
        terminal_turn: terminal.then(|| input.turn_id.clone()),
    })
}

fn apply_projection(
    tx: transaction::Transaction<'_>,
    input: ResolvedInput<'_>,
) -> Result<ProjectionOutcome, AppStorageError> {
    if input.is_runtime_event || input.is_progress {
        project_resumed(
            &tx,
            input.subscribers,
            input.chat_id,
            &input.turn_id,
            input.now,
        )?;
    }
    let terminal = project_kind(&tx, &input)?;
    let wake_queue = match terminal.as_deref() {
        Some(code) => settle_if_claimed(
            &tx,
            input.subscribers,
            input.chat_id,
            &input.turn_id,
            input.claim_id.as_deref(),
            code,
            input.now,
        )?,
        None => false,
    };
    finish(
        &tx,
        input.action_id,
        input.outbound,
        input.chat_id,
        input.cursor,
        input.now,
    )?;
    batch::update_chat(&tx, input.chat_id, input.now)?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(ProjectionOutcome {
        handled: true,
        wake_queue,
        terminal_turn: terminal.map(|_| input.turn_id),
    })
}

fn project_kind(
    tx: &transaction::Transaction<'_>,
    input: &ResolvedInput<'_>,
) -> Result<Option<String>, AppStorageError> {
    if input.is_runtime_event {
        return Ok(project_runtime_event(RuntimeInput {
            db: tx,
            subscribers: input.subscribers,
            chat: input.chat_id,
            turn: &input.turn_id,
            metadata: input.metadata,
            message: input.message,
            now: input.now,
            generated_id: &input.ids.event_id,
        })?
        .map(str::to_owned));
    }
    if input.is_progress {
        project_progress(ProgressInput {
            db: tx,
            subscribers: input.subscribers,
            chat: input.chat_id,
            turn: &input.turn_id,
            action: input.action_id,
            kind: &input.kind,
            metadata: input.metadata,
            message: input.message,
            timestamp: &input.outbound.timestamp,
            now: input.now,
            event_id: &input.ids.event_id,
        })?;
        return Ok(None);
    }
    if input.kind == "turn_cancellation_ack" {
        project_cancellation_ack(
            tx,
            &input.turn_id,
            input.metadata,
            &input.outbound.timestamp,
        )?;
        return Ok(None);
    }
    if input.kind == "turn_cancelled" {
        project_cancelled(
            tx,
            input.subscribers,
            input.chat_id,
            &input.turn_id,
            input.metadata,
            input.now,
            &input.ids.event_id,
        )?;
        return Ok(Some("turn_cancelled".to_owned()));
    }
    project_failed(
        tx,
        input.subscribers,
        input.chat_id,
        &input.turn_id,
        FailedProjection {
            metadata: input.metadata,
            message: input.message,
            retryable: input.metadata.get("retryable").and_then(Value::as_bool) == Some(true),
        },
        input.now,
        &input.ids,
    )?;
    Ok(Some(
        token(input.metadata.get("safeErrorCode")).unwrap_or_else(|| "gateway_failed".to_owned()),
    ))
}

fn finish_terminal(
    tx: transaction::Transaction<'_>,
    input: &ResolvedInput<'_>,
    outcome: ProjectionOutcome,
) -> Result<ProjectionOutcome, AppStorageError> {
    finish(
        &tx,
        input.action_id,
        input.outbound,
        input.chat_id,
        input.cursor,
        input.now,
    )?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(outcome)
}

fn no_terminal() -> ProjectionOutcome {
    ProjectionOutcome {
        handled: true,
        wake_queue: false,
        terminal_turn: None,
    }
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
    record_tool_work(db, turn, &kind)?;
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
    tx: transaction::Transaction<'_>,
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
