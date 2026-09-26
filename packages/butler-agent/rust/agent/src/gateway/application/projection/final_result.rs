//! Claim-fenced App projection of transport final results.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::{final_candidate::FinalCandidate, staging};
use crate::gateway::application::{
    MaterializedResponderFile,
    events::EventSubscribers,
    queue::{self, QueuedTurnClaimStatus},
    read_model,
    storage::AppStorageError,
};

pub(super) struct FinalApply<'a> {
    pub files: Vec<MaterializedResponderFile>,
    pub reply_id: &'a str,
    pub now: &'a str,
    pub subscribers: &'a EventSubscribers,
    pub checkpoint: Option<&'a super::checkpoint::Checkpoint>,
    pub continuation: Option<super::super::settings::PlanContinuation>,
    pub turn_event_ids: super::final_turn_events::FinalTurnEventIds,
}

pub(super) fn apply(
    db: &mut Connection,
    input: FinalCandidate,
    apply: FinalApply<'_>,
) -> Result<bool, AppStorageError> {
    let tx = db.transaction().map_err(AppStorageError::sqlite)?;
    if staging::projected(&tx, &input.action_id)? {
        return Ok(false);
    }
    let mut status = queue::claim_status(
        &tx,
        &input.chat_id,
        &input.turn_id,
        input.claim_id.as_deref(),
    )?;
    if status == QueuedTurnClaimStatus::Stale
        && input.processed_claim_verified
        && let (Some(claim), Some(reply_to)) = (
            input.claim_id.as_deref(),
            input.reply_to_message_id.as_deref(),
        )
        && queue::restore_delivered_claim(&tx, &input.chat_id, &input.turn_id, claim, reply_to)?
    {
        status = QueuedTurnClaimStatus::Current;
    }
    if matches!(
        status,
        QueuedTurnClaimStatus::Terminal | QueuedTurnClaimStatus::Stale
    ) {
        return Ok(false);
    }
    if status == QueuedTurnClaimStatus::Current
        && !queue::fence(
            &tx,
            &input.chat_id,
            &input.turn_id,
            input.claim_id.as_deref().unwrap_or(""),
        )?
    {
        return Ok(false);
    }
    let current_existing: Option<String>=tx.query_row(
        "SELECT id FROM messages WHERE chat_id=?1 AND turn_id=?2 AND role='assistant' ORDER BY rowid DESC LIMIT 1",
        params![input.chat_id,input.turn_id],|row|row.get(0)).optional().map_err(AppStorageError::sqlite)?;
    if current_existing != input.existing_message_id {
        return Err(AppStorageError::new(
            "app_projection_message_changed",
            "Assistant message changed during artifact materialization.",
        ));
    }
    let visible = !input.text.is_empty()
        || !apply.files.is_empty()
        || !input.changed_files.is_empty()
        || input.plan.is_some();
    if input.no_visible_reply || !visible {
        super::final_turn_events::append_if_missing(
            &tx,
            apply.subscribers,
            super::final_turn_events::TurnEventInput {
                session_id: &input.chat_id,
                turn_id: &input.turn_id,
                kind: "turn.failed",
                payload: object_value(json!({
                    "safeLabel":"No visible answer",
                    "safeErrorCode":"no_visible_result"
                }))?,
                event_id: &apply.turn_event_ids.failed,
                created_at: apply.now,
            },
        )?;
        tx.execute("UPDATE turns SET state='failed',safe_status_label='Failed',safe_error_code='no_visible_result',retryable=0,cancellable=0,updated_at=?1 WHERE id=?2",params![apply.now,input.turn_id]).map_err(AppStorageError::sqlite)?;
        append_turn_state_changed(
            &tx,
            apply.subscribers,
            &input.chat_id,
            &input.turn_id,
            apply.now,
        )?;
        settle(
            &tx,
            apply.subscribers,
            &input,
            "no_visible_result",
            None,
            apply.now,
        )?;
    } else {
        let message_id = current_existing.as_deref().unwrap_or(apply.reply_id);
        super::final_turn_events::append_if_missing(
            &tx,
            apply.subscribers,
            super::final_turn_events::TurnEventInput {
                session_id: &input.chat_id,
                turn_id: &input.turn_id,
                kind: "message.final.started",
                payload: object_value(json!({"safeLabel":"Preparing final answer"}))?,
                event_id: &apply.turn_event_ids.started,
                created_at: apply.now,
            },
        )?;
        if current_existing.is_some() {
            tx.execute("UPDATE messages SET text=?1,status='delivered',updated_at=?2,safe_error_code=NULL,retryable=0,plan_json=?3 WHERE id=?4",
                params![input.text,apply.now,input.plan.as_ref().map(Value::to_string),message_id]).map_err(AppStorageError::sqlite)?;
            tx.execute(
                "DELETE FROM message_attachments WHERE message_id=?1",
                [message_id],
            )
            .map_err(AppStorageError::sqlite)?;
            tx.execute(
                "DELETE FROM message_changed_files WHERE message_id=?1",
                [message_id],
            )
            .map_err(AppStorageError::sqlite)?;
        } else {
            tx.execute("INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at,retryable,plan_json) VALUES(?1,?2,?3,'assistant',?4,'delivered',?5,?5,0,?6)",
                params![message_id,input.chat_id,input.turn_id,input.text,apply.now,input.plan.as_ref().map(Value::to_string)]).map_err(AppStorageError::sqlite)?;
        }
        attach_files(&tx, &input.chat_id, message_id, apply.files)?;
        for (position, detail) in input.changed_files.iter().enumerate() {
            tx.execute("INSERT INTO message_changed_files(message_id,position,safe_path_label,detail_json) VALUES(?1,?2,?3,?4)",
                params![message_id,position,detail.get("path").and_then(Value::as_str).unwrap_or(""),detail.to_string()]).map_err(AppStorageError::sqlite)?;
        }
        super::final_turn_events::append_if_missing(
            &tx,
            apply.subscribers,
            super::final_turn_events::TurnEventInput {
                session_id: &input.chat_id,
                turn_id: &input.turn_id,
                kind: "message.final.completed",
                payload: object_value(
                    json!({"safeLabel":"Final answer ready","textChars":input.text.encode_utf16().count()}),
                )?,
                event_id: &apply.turn_event_ids.completed,
                created_at: apply.now,
            },
        )?;
        tx.execute("UPDATE turns SET state='delivered',safe_status_label='Delivered',safe_error_code=NULL,retryable=0,cancellable=0,updated_at=?1 WHERE id=?2",params![apply.now,input.turn_id]).map_err(AppStorageError::sqlite)?;
        append_turn_state_changed(
            &tx,
            apply.subscribers,
            &input.chat_id,
            &input.turn_id,
            apply.now,
        )?;
        let mut completion_payload = object_value(json!({"safeLabel":"Completed"}))?;
        if let Some(delivery) = input.delivery_metadata.as_ref() {
            completion_payload.extend(delivery.clone());
        }
        super::final_turn_events::append_if_missing(
            &tx,
            apply.subscribers,
            super::final_turn_events::TurnEventInput {
                session_id: &input.chat_id,
                turn_id: &input.turn_id,
                kind: "turn.completed",
                payload: completion_payload,
                event_id: &apply.turn_event_ids.turn_completed,
                created_at: apply.now,
            },
        )?;
        settle(
            &tx,
            apply.subscribers,
            &input,
            "",
            Some(message_id),
            apply.now,
        )?;
        if let Some(continuation) = apply.continuation {
            super::super::settings::create_plan_continuation(
                &tx,
                apply.subscribers,
                continuation,
                apply.now,
            )?;
        }
        let message = read_model::list_messages(&tx, &input.chat_id, 0.0, 200)?
            .messages
            .into_iter()
            .find(|row| row.id == message_id)
            .ok_or_else(|| {
                AppStorageError::new(
                    "projected_message_missing",
                    "Projected message was not found.",
                )
            })?;
        super::super::events::append(
            &tx,
            apply.subscribers,
            "message.created",
            Some(&input.turn_id),
            object_value(json!({"message":message}))?,
            apply.now,
        )?;
    }
    staging::delete(&tx, &input.action_id)?;
    staging::mark(
        &tx,
        &input.action_id,
        &input.event_id,
        &input.chat_id,
        apply.now,
    )?;
    tx.execute(
        "UPDATE chats SET updated_at=?1 WHERE id=?2",
        params![apply.now, input.chat_id],
    )
    .map_err(AppStorageError::sqlite)?;
    if let Some(checkpoint) = apply.checkpoint {
        super::checkpoint::save(&tx, checkpoint, apply.now)?;
    }
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(true)
}

fn settle(
    db: &Connection,
    subscribers: &EventSubscribers,
    input: &FinalCandidate,
    error: &str,
    message: Option<&str>,
    now: &str,
) -> Result<(), AppStorageError> {
    if queue::claim_status(
        db,
        &input.chat_id,
        &input.turn_id,
        input.claim_id.as_deref(),
    )? == QueuedTurnClaimStatus::Unlinked
    {
        return Ok(());
    }
    let claim = input.claim_id.as_deref().ok_or_else(|| {
        AppStorageError::new(
            "queued_message_claim_missing",
            "Queued result omitted its claim.",
        )
    })?;
    if !queue::settle(
        db,
        &input.chat_id,
        &input.turn_id,
        claim,
        message,
        (!error.is_empty()).then_some(error),
        now,
    )? {
        return Err(AppStorageError::new(
            "queued_message_claim_lost",
            "Queued message claim was lost.",
        ));
    }
    let action = if error.is_empty() {
        "dispatched"
    } else {
        "failed"
    };
    let mut payload = object_value(json!({
        "session_id":input.chat_id,
        "turn_id":input.turn_id,
        "action":action
    }))?;
    if let Some(message) = message {
        payload.insert("result_message_id".into(), message.into());
    }
    if !error.is_empty() {
        payload.insert("safe_error_code".into(), error.into());
    }
    super::super::events::append(
        db,
        subscribers,
        "session_queue.changed",
        Some(&input.turn_id),
        payload,
        now,
    )?;
    Ok(())
}
fn attach_files(
    db: &Connection,
    chat: &str,
    message: &str,
    files: Vec<MaterializedResponderFile>,
) -> Result<(), AppStorageError> {
    for (position, file) in files.into_iter().take(12).enumerate() {
        db.execute("INSERT INTO message_files(id,owner_session_id,message_id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![file.id,chat,message,file.kind,file.mime_type,file.safe_name,file.size_bytes,file.sha256,file.storage_name,file.created_at]).map_err(AppStorageError::sqlite)?;
        db.execute(
            "INSERT INTO message_attachments(message_id,file_id,position) VALUES(?1,?2,?3)",
            params![message, file.id, position],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}
fn append_turn_state_changed(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat_id: &str,
    turn: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    let turn_view = read_model::list_turns(db, chat_id, 0.0)?
        .turns
        .into_iter()
        .find(|row| row.id == turn)
        .ok_or_else(|| {
            AppStorageError::new("projected_turn_missing", "Projected Turn was not found.")
        })?;
    super::super::events::append(
        db,
        subscribers,
        "turn.state_changed",
        Some(turn),
        object_value(json!({"turn":turn_view}))?,
        now,
    )
    .map(|_| ())
}

fn object_value(value: Value) -> Result<Map<String, Value>, AppStorageError> {
    value.as_object().cloned().ok_or_else(|| {
        AppStorageError::new(
            "app_projection_payload_invalid",
            "Projection payload is invalid.",
        )
    })
}
