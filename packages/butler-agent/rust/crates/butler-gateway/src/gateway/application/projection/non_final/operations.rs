//! Terminal, operation-output, and worker-result projection mutations.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::{
    ApplyInput, ProjectionIds, ProjectionOutcome, finish, not_handled, object, short_text, text,
    token,
};
use crate::gateway::application::projection::staging;
use crate::gateway::application::retry::INTERRUPTED_TURN_CODE;
use crate::gateway::application::storage::AppStorageCode;
use crate::gateway::application::{
    events::{self, EventSubscribers},
    queue::{self, QueuedTurnClaimStatus},
    service,
    storage::AppStorageError,
};

#[derive(Clone, Copy)]
pub(super) struct FailedProjection<'a> {
    pub metadata: &'a Map<String, Value>,
    pub message: &'a Map<String, Value>,
    pub retryable: bool,
}

pub(super) fn project_failed(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat: &str,
    turn: &str,
    failed: FailedProjection<'_>,
    now: &str,
    ids: &ProjectionIds,
) -> Result<(), AppStorageError> {
    let FailedProjection {
        metadata,
        message,
        retryable: requested_retryable,
    } = failed;
    let code = error_token(metadata.get("safeErrorCode"));
    // A turn interrupted by a crash is failed but always retryable: the retry
    // resumes it from its durable state.
    let retryable =
        (code == "runtime_fault" && requested_retryable) || code == INTERRUPTED_TURN_CODE;
    let label = if code == "internal_recovery_required" {
        "Butler could not complete this turn.".into()
    } else {
        text(message.get("text"))
            .filter(|v| !v.is_empty())
            .map(|v| short_text(&v, 240))
            .unwrap_or_else(|| "Butler could not complete this turn.".into())
    };
    let existing: Option<String> = db.query_row("SELECT id FROM messages WHERE chat_id=?1 AND turn_id=?2 AND role='assistant' ORDER BY rowid DESC LIMIT 1", params![chat,turn], |row|row.get(0)).optional().map_err(AppStorageError::sqlite)?;
    let message_id = existing.as_deref().unwrap_or(&ids.message_id);
    if existing.is_some() { db.execute("UPDATE messages SET text=?1,status='failed',safe_error_code=?2,retryable=?3,updated_at=?4 WHERE id=?5",params![label,code,retryable,now,message_id]) }
    else { db.execute("INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at,safe_error_code,retryable) VALUES(?1,?2,?3,'assistant',?4,'failed',?5,?5,?6,?7)",params![message_id,chat,turn,label,now,code,retryable]) }
        .map_err(AppStorageError::sqlite)?;
    db.execute("UPDATE turns SET state=?1,safe_status_label=?2,safe_error_code=?3,retryable=?4,cancellable=0,updated_at=?5 WHERE id=?6",params![if code=="runtime_fault"{"runtime_fault"}else{"failed"},if code=="runtime_fault"{"Runtime fault"}else{"Failed"},code,retryable,now,turn]).map_err(AppStorageError::sqlite)?;
    events::append(
        db,
        subscribers,
        if code == "runtime_fault" {
            "runtime.fault"
        } else {
            "turn.failed"
        },
        Some(turn),
        service::map(
            &json!({"session_id":chat,"turn_id":turn,"safeLabel":label,"safeErrorCode":code,"retryable":retryable}),
        )?,
        now,
    )?;
    events::append(
        db,
        subscribers,
        "turn.state_changed",
        Some(turn),
        service::map(
            &json!({"session_id":chat,"turn_id":turn,"state":if code=="runtime_fault"{"runtime_fault"}else{"failed"},"safe_status_label":if code=="runtime_fault"{"Runtime fault"}else{"Failed"},"safe_error_code":code,"retryable":retryable,"cancellable":false}),
        )?,
        now,
    )?;
    Ok(())
}

pub(super) fn project_cancelled(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat: &str,
    turn: &str,
    metadata: &Map<String, Value>,
    now: &str,
    _event_id: &str,
) -> Result<(), AppStorageError> {
    db.execute("UPDATE app_turn_cancel_outbox SET state='completed',accepted_at=COALESCE(accepted_at,?1),completed_at=?1,safe_error_code=NULL WHERE turn_id=?2 AND state IN ('pending','accepted')",params![now,turn]).map_err(AppStorageError::sqlite)?;
    super::stream_message::stop(db, subscribers, chat, turn, now)?;
    db.execute("UPDATE turns SET state='cancelled',safe_status_label='Cancelled',safe_error_code='turn_cancelled',retryable=0,cancellable=0,updated_at=?1 WHERE id=?2 AND state<>'cancelled'",params![now,turn]).map_err(AppStorageError::sqlite)?;
    events::append(
        db,
        subscribers,
        "turn.state_changed",
        Some(turn),
        service::map(
            &json!({"session_id":chat,"turn_id":turn,"state":"cancelled","safe_status_label":"Cancelled","safe_error_code":"turn_cancelled","retryable":false,"cancellable":false}),
        )?,
        now,
    )?;
    let _ = metadata;
    Ok(())
}

pub(super) fn project_cancellation_ack(
    db: &Connection,
    turn: &str,
    metadata: &Map<String, Value>,
    timestamp: &str,
) -> Result<(), AppStorageError> {
    let delivered = metadata.get("outcome").and_then(Value::as_str) == Some("already_delivered");
    db.execute("UPDATE app_turn_cancel_outbox SET state=?1,queue_id=?2,dispatch_claim_id=?3,accepted_at=?4,completed_at=?5,safe_error_code=NULL WHERE turn_id=?6 AND state='pending'",params![if delivered{"completed"}else{"accepted"},token(metadata.get("queueId")),token(metadata.get("dispatchClaimId")),timestamp,delivered.then_some(timestamp),turn]).map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(super) fn project_suspended(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat: &str,
    turn: &str,
    claim: Option<&str>,
    metadata: &Map<String, Value>,
    now: &str,
) -> Result<(bool, bool), AppStorageError> {
    let authority_pending =
        metadata.get("suspension").and_then(Value::as_str) == Some("authority_pending");
    let (state, label, cancellable) = if authority_pending {
        ("waiting_for_form", "Waiting for your response", 1)
    } else {
        ("delivered", "", 0)
    };
    db.execute(
        "UPDATE turns SET state=?1,safe_status_label=?2,safe_error_code=NULL,retryable=0,cancellable=?3,updated_at=?4 WHERE id=?5",
        params![state, label, cancellable, now, turn],
    ).map_err(AppStorageError::sqlite)?;
    events::append(
        db,
        subscribers,
        "turn.state_changed",
        Some(turn),
        service::map(&json!({
            "session_id":chat,"turn_id":turn,"state":state,"safe_status_label":label,
            "retryable":false,"cancellable":authority_pending
        }))?,
        now,
    )?;
    if authority_pending {
        return Ok((false, false));
    }
    super::stream_message::settle_suspended(db, subscribers, chat, turn, now)?;
    if queue::claim_status(db, chat, turn, claim)? == QueuedTurnClaimStatus::Unlinked {
        return Ok((true, false));
    }
    let Some(claim) = claim else {
        return Ok((false, false));
    };
    if !queue::settle(db, chat, turn, claim, None, None, now)? {
        return Ok((false, false));
    }
    events::append(
        db,
        subscribers,
        "session_queue.changed",
        Some(turn),
        service::map(&json!({
            "session_id":chat,"turn_id":turn,"action":"dispatched"
        }))?,
        now,
    )?;
    Ok((true, true))
}

pub(super) fn settle_if_claimed(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat: &str,
    turn: &str,
    claim: Option<&str>,
    code: &str,
    now: &str,
) -> Result<bool, AppStorageError> {
    if queue::claim_status(db, chat, turn, claim)? == QueuedTurnClaimStatus::Unlinked {
        return Ok(false);
    }
    let Some(claim) = claim else { return Ok(false) };
    if !queue::settle(db, chat, turn, claim, None, Some(code), now)? {
        return Ok(false);
    }
    events::append(
        db,
        subscribers,
        "session_queue.changed",
        Some(turn),
        service::map(
            &json!({"session_id":chat,"turn_id":turn,"action":"failed","safe_error_code":code}),
        )?,
        now,
    )?;
    Ok(true)
}

pub(super) fn operation_output(
    db: &Connection,
    turn: &str,
    p: &Map<String, Value>,
    now: &str,
) -> Result<(), AppStorageError> {
    let request = operation_token(p, "requestId")?;
    let result = operation_token(p, "resultId")?;
    let chunk = crate::gateway::application::operation_output::OperationOutputChunk::from_payload(
        p, &request, &result,
    )
    .ok_or_else(|| {
        AppStorageError::new(
            AppStorageCode::OperationOutputChunkInvalid,
            "Invalid operation output chunk",
        )
    })?;
    let digest = &chunk.result_sha256;
    let content_digest = &chunk.content_sha256;
    let content = &chunk.content_base64;
    let values = [
        chunk.chunk_index,
        chunk.chunk_count,
        chunk.byte_start,
        chunk.byte_end,
        chunk.byte_length,
    ];
    let changed=db.execute("INSERT OR IGNORE INTO app_operation_output_chunks(turn_id,request_id,result_id,result_sha256,chunk_index,chunk_count,byte_start,byte_end,byte_length,content_base64,content_sha256,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",params![turn,request,result,digest,values[0],values[1],values[2],values[3],values[4],content,content_digest,now]).map_err(AppStorageError::sqlite)?;
    if changed == 0 {
        let content_matches: bool = db.query_row("SELECT content_base64=?4 AND content_sha256=?5 AND result_sha256=?6 FROM app_operation_output_chunks WHERE turn_id=?1 AND request_id=?2 AND result_id=?3 AND chunk_index=?7", params![turn,request,result,content,content_digest,digest,values[0]], |row| row.get(0)).map_err(AppStorageError::sqlite)?;
        if !content_matches {
            butler_core::diagnostic!(
                "warning: operation output chunk replay content mismatch for {turn}/{request}/{result}"
            );
        }
        let same:Option<i64>=db.query_row("SELECT 1 FROM app_operation_output_chunks WHERE turn_id=?1 AND request_id=?2 AND result_id=?3 AND chunk_index=?4 AND chunk_count=?5 AND byte_start=?6 AND byte_end=?7 AND byte_length=?8",params![turn,request,result,values[0],values[1],values[2],values[3],values[4]],|r|r.get(0)).optional().map_err(AppStorageError::sqlite)?;
        if same.is_none() {
            return Err(AppStorageError::new(
                AppStorageCode::OperationOutputChunkConflict,
                "Conflicting operation output chunk replay",
            ));
        }
    }
    Ok(())
}

pub(super) fn project_worker_result(
    db: &mut Connection,
    input: ApplyInput<'_>,
) -> Result<ProjectionOutcome, AppStorageError> {
    let ApplyInput {
        chat_id: chat,
        action_id: action,
        outbound: event,
        cursor,
        now,
        subscribers,
        ids,
        worker_files: files,
    } = input;
    let message = object(event.payload.get("message"));
    let text = text(message.get("text")).unwrap_or_default();
    if text.is_empty() && files.is_empty() {
        return Ok(not_handled());
    }
    let tx = db.transaction().map_err(AppStorageError::sqlite)?;
    if staging::projected(&tx, action)? {
        return Ok(ProjectionOutcome {
            handled: true,
            wake_queue: false,
            terminal_turn: None,
        });
    }
    tx.execute("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at,retryable) VALUES(?1,?2,'assistant',?3,'delivered',?4,?4,0)",params![ids.message_id,chat,text,now]).map_err(AppStorageError::sqlite)?;
    for (position, file) in files.into_iter().take(12).enumerate() {
        tx.execute("INSERT INTO message_files(id,owner_session_id,message_id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![file.id,chat,ids.message_id,file.kind,file.mime_type,file.safe_name,file.size_bytes,file.sha256,file.storage_name,file.created_at]).map_err(AppStorageError::sqlite)?;
        tx.execute(
            "INSERT INTO message_attachments(message_id,file_id,position) VALUES(?1,?2,?3)",
            params![ids.message_id, file.id, position],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    let row = crate::gateway::application::read_model::list_messages(&tx, chat, 0.0, 200)?
        .messages
        .into_iter()
        .find(|m| m.id == ids.message_id)
        .ok_or_else(|| {
            AppStorageError::new(
                AppStorageCode::ProjectedMessageMissing,
                "Projected message missing",
            )
        })?;
    events::append(
        &tx,
        subscribers,
        "message.created",
        None,
        service::map(&json!({"message":row}))?,
        now,
    )?;
    finish(&tx, action, event, chat, cursor, now)?;
    tx.execute(
        "UPDATE chats SET updated_at=?1 WHERE id=?2",
        params![now, chat],
    )
    .map_err(AppStorageError::sqlite)?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(ProjectionOutcome {
        handled: true,
        wake_queue: false,
        terminal_turn: None,
    })
}

fn error_token(value: Option<&Value>) -> String {
    let normalized = text(value)
        .unwrap_or_default()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || "_.:-".contains(character) {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_lowercase();
    let bounded = normalized.chars().take(80).collect::<String>();
    if bounded.is_empty() {
        "gateway_failed".into()
    } else {
        bounded
    }
}

fn operation_token(payload: &Map<String, Value>, key: &str) -> Result<String, AppStorageError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 512)
        .map(str::to_owned)
        .ok_or_else(|| {
            AppStorageError::new(
                AppStorageCode::OperationOutputChunkInvalid,
                format!("{key} invalid"),
            )
        })
}
