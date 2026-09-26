//! App-owned retry actions for runtime-faulted turns.

mod source;

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::{
    AppApplication, AppStorageError, GatewayApplicationError, SendMessageCommand, app_error,
    events, public, queue, read_model, send::ResolvedAppAdmission, service, settings,
};
use crate::{
    btcc::SubsessionResultContext,
    gateway::{MessageSendRequest, MessageSendResult},
};
use source::{current_controls_retry_source, retry_snapshot, verified_execution_controls};

impl AppApplication {
    pub(super) async fn retry_turn_owned(
        &self,
        turn_id: String,
    ) -> Result<Value, GatewayApplicationError> {
        self.recover_expired().await?;

        let now = self.dependencies.identity_clock.now_iso();
        let queue_id = format!("queued-{}", self.dependencies.identity_clock.new_uuid());
        let claim_id = self.dependencies.identity_clock.new_uuid();
        let claim_owner = self.queue_owner.clone();
        let lease_expires_at = self
            .dependencies
            .identity_clock
            .iso_after_millis(queue::SESSION_QUEUE_LEASE_MILLIS as u64);
        let subscribers = self.subscribers.clone();
        let operation_turn = turn_id.clone();
        let (claim, prepared) = self
            .storage
            .execute(move |db| {
                let transaction = db.transaction().map_err(AppStorageError::sqlite)?;
                let snapshot = retry_snapshot(&transaction, &operation_turn)?;
                let (verified, controls) = verified_execution_controls(&snapshot)?;
                let status_label = retry_status_label(verified.subsession_result.as_ref());
                let attempt = snapshot.attempt.saturating_add(1);
                let changed = transaction
                    .execute(
                        "UPDATE turns SET state='retrying',safe_status_label=?1,\
                         safe_status_label_key=NULL,safe_status_label_parameters_json=NULL,\
                         safe_status_content_json=NULL,safe_error_code=NULL,retryable=0,\
                         cancellable=?2,attempt=?3,updated_at=?4 \
                         WHERE id=?5 AND state='runtime_fault' AND retryable=1 AND attempt=?6",
                        params![
                            status_label,
                            verified.subsession_result.is_none(),
                            attempt,
                            now,
                            operation_turn,
                            snapshot.attempt
                        ],
                    )
                    .map_err(AppStorageError::sqlite)?;
                if changed != 1 {
                    return Err(not_retryable_error());
                }
                let turn = read_model::exact_turn(&transaction, &operation_turn)?
                    .ok_or_else(|| AppStorageError::new("turn_not_found", "Turn not found."))?;
                events::append(
                    &transaction,
                    &subscribers,
                    "turn.state_changed",
                    Some(&operation_turn),
                    service::map(json!({"turn":turn}))?,
                    &now,
                )?;
                delete_assistant_messages(
                    &transaction,
                    &subscribers,
                    &operation_turn,
                    &snapshot.chat_id,
                    &now,
                )?;

                let reservation = queue::QueueReservation {
                    id: queue_id.clone(),
                    chat_id: snapshot.chat_id.clone(),
                    text: snapshot.text.clone(),
                    client_message_id: format!(
                        "retry-{operation_turn}-{}",
                        snapshot.attempt.saturating_add(1)
                    ),
                    input_identity_digest: snapshot.input_identity_digest.clone(),
                    control_resolution_json: snapshot.control_resolution_json,
                    controls_json: snapshot.controls_json,
                    attachments_json: snapshot.attachments_json,
                    content_parts_json: snapshot.content_parts_json,
                    project_source_refs_json: snapshot.project_source_refs_json,
                    created_at: now.clone(),
                };
                queue::reserve(&transaction, &reservation)?;
                let requested_claim = queue::QueueClaim {
                    queued_message_id: queue_id,
                    chat_id: snapshot.chat_id.clone(),
                    claim_id,
                    claim_owner,
                    lease_expires_at,
                };
                let claim = queue::claim(&transaction, &requested_claim, &now, &subscribers)?
                    .ok_or_else(|| {
                        AppStorageError::new(
                            "turn_retry_dispatch_busy",
                            "The session already has a message being dispatched.",
                        )
                    })?;
                if !queue::link_dispatch(
                    &transaction,
                    &claim,
                    &snapshot.user_message_id,
                    &operation_turn,
                    &now,
                )? {
                    return Err(AppStorageError::new(
                        "queued_message_claim_lost",
                        "Queued message claim was lost.",
                    ));
                }
                let prepared = ResolvedAppAdmission {
                    text: snapshot.text,
                    controls,
                };
                transaction.commit().map_err(AppStorageError::sqlite)?;
                Ok((claim, prepared))
            })
            .await
            .map_err(map_retry_error)?;

        self.start_turn(claim, prepared).await?;
        let turn = self
            .storage
            .execute(move |db| read_model::exact_turn(db, &turn_id))
            .await
            .map_err(app_error)?
            .ok_or_else(|| public(404, "turn_not_found", "Turn not found."))?;
        let next_cursor = turn.cursor;
        Ok(json!({"turn":turn,"replies":[],"next_cursor":next_cursor}))
    }

    pub(super) async fn retry_turn_with_current_controls_owned(
        &self,
        turn_id: String,
    ) -> Result<MessageSendResult, GatewayApplicationError> {
        self.recover_expired().await?;
        let operation_turn = turn_id;
        let source = self
            .storage
            .execute(move |db| current_controls_retry_source(db, &operation_turn))
            .await
            .map_err(map_retry_error)?;
        let request = MessageSendRequest {
            expected_project_id: None,
            content_parts: None,
            chat_id: Some(Value::String(source.chat_id.clone())),
            text: Some(Value::String(source.text)),
            client_message_id: None,
            attachments: Some(Value::Array(
                source
                    .attachment_ids
                    .into_iter()
                    .map(|file_id| json!({"file_id":file_id}))
                    .collect(),
            )),
            model: None,
            reasoning_effort: None,
            access_mode: None,
            plan_mode: None,
            subsession_result: None,
        };
        self.send_with_reused_attachments(
            SendMessageCommand {
                chat_id: source.chat_id,
                request,
            },
            source.user_message_id,
        )
        .await
    }
}

fn delete_assistant_messages(
    db: &Connection,
    subscribers: &super::events::EventSubscribers,
    turn_id: &str,
    chat_id: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT id FROM messages WHERE chat_id=?1 AND turn_id=?2 AND role='assistant' \
             ORDER BY rowid DESC",
        )
        .map_err(AppStorageError::sqlite)?;
    let ids = statement
        .query_map(params![chat_id, turn_id], |row| row.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    drop(statement);
    for id in ids {
        db.execute(
            "UPDATE message_files SET message_id=NULL WHERE message_id=?1",
            [&id],
        )
        .map_err(AppStorageError::sqlite)?;
        db.execute("DELETE FROM message_attachments WHERE message_id=?1", [&id])
            .map_err(AppStorageError::sqlite)?;
        db.execute("DELETE FROM messages WHERE id=?1", [&id])
            .map_err(AppStorageError::sqlite)?;
        events::append(
            db,
            subscribers,
            "message.deleted",
            Some(turn_id),
            service::map(
                json!({"message_id":id,"chat_id":chat_id,"turn_id":turn_id,"role":"assistant"}),
            )?,
            now,
        )?;
    }
    Ok(())
}

fn retry_status_label(context: Option<&SubsessionResultContext>) -> String {
    context.map_or_else(
        || "Retrying".to_owned(),
        |context| format!("{} 작업에 대한 보고 준비 중", context.safe_title),
    )
}

fn not_retryable_error() -> AppStorageError {
    AppStorageError::new("turn_not_retryable", "Turn is not retryable.")
}

fn queue_snapshot_error() -> AppStorageError {
    AppStorageError::new(
        "turn_retry_snapshot_missing",
        "Turn retry snapshot is unavailable.",
    )
}

fn execution_controls_error() -> AppStorageError {
    AppStorageError::new(
        "turn_execution_controls_missing",
        "This legacy turn does not have an immutable execution snapshot and cannot be retried safely.",
    )
}

fn map_retry_error(error: AppStorageError) -> GatewayApplicationError {
    match error.code() {
        "turn_not_found" => public(404, error.code(), error.detail()),
        "turn_not_retryable"
        | "turn_missing_user_message"
        | "turn_execution_controls_missing"
        | "turn_retry_snapshot_missing"
        | "turn_retry_dispatch_busy" => public(409, error.code(), error.detail()),
        _ => app_error(error),
    }
}
