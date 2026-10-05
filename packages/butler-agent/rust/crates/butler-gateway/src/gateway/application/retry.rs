//! App-owned retry actions for runtime-faulted turns.

mod source;

#[cfg(test)]
pub(in crate::gateway::application) use source::RUNTIME_FAULT_SQL;

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::{
    AppApplication, AppStorageError, GatewayApplicationError, SendMessageCommand, app_error,
    events, public, queue, read_model, send::ResolvedAppAdmission, service, settings,
};
use crate::gateway::application::storage::AppStorageCode;
use crate::gateway::{MessageSendRequest, MessageSendResult};
use butler_turn::btcc::SubsessionResultContext;
use source::{
    current_controls_retry_source, reservation, retry_snapshot, verified_execution_controls,
};

/// Safe error code of a turn a crashed service process was running. Such a
/// turn is failed and retryable; `/retry` resumes it (owner decision: never
/// resumed automatically). `/retry-current` refuses it: a fresh turn could
/// run the interrupted turn's completed tool effects again.
pub(super) const INTERRUPTED_TURN_CODE: &str = "turn_interrupted";

impl AppApplication {
    pub(super) async fn retry_turn_owned(
        &self,
        turn_id: String,
    ) -> Result<Value, GatewayApplicationError> {
        // Recovery publishes terminal turns before the dispatcher's first poll.
        // Wait before reserving a retry so startup cannot strand its claim.
        self.wait_retry_ready().await?;
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
        let (claim, prepared) =
            self.storage
                .execute(move |db| {
                    let transaction = db.savepoint().map_err(AppStorageError::sqlite)?;
                    let snapshot = retry_snapshot(&transaction, &operation_turn)?;
                    let (verified, controls) = verified_execution_controls(&snapshot)?;
                    let status_label = retry_status_label(verified.subsession_result.as_ref());
                    mark_retrying(
                        &transaction,
                        &operation_turn,
                        &status_label,
                        verified.subsession_result.is_none(),
                        snapshot.attempt,
                        &now,
                    )?;
                    let turn = read_model::exact_turn(&transaction, &operation_turn)?.ok_or_else(
                        || AppStorageError::new(AppStorageCode::TurnNotFound, "Turn not found."),
                    )?;
                    events::append(
                        &transaction,
                        &subscribers,
                        "turn.state_changed",
                        Some(&operation_turn),
                        service::map(&json!({"turn":turn}))?,
                        &now,
                    )?;
                    delete_assistant_messages(
                        &transaction,
                        &subscribers,
                        &operation_turn,
                        &snapshot.chat_id,
                        &now,
                    )?;

                    let reservation = reservation(&snapshot, &queue_id, &now);
                    queue::reserve(&transaction, &reservation)?;
                    let requested_claim = queue::QueueClaim {
                        queued_message_id: queue_id,
                        chat_id: snapshot.chat_id.clone(),
                        claim_id,
                        claim_owner,
                        lease_expires_at,
                    };
                    let claim = queue::claim(
                        &transaction,
                        &requested_claim,
                        queue::ClaimOrder::Immediate,
                        &now,
                        &subscribers,
                    )?
                    .ok_or_else(|| {
                        AppStorageError::new(
                            AppStorageCode::TurnRetryDispatchBusy,
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
                            AppStorageCode::QueuedMessageClaimLost,
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
        self.retry_view(turn_id).await
    }

    async fn wait_retry_ready(&self) -> Result<(), GatewayApplicationError> {
        tokio::select! {
            biased;
            () = self.dependencies.service_shutdown.cancelled() => {
                return Err(public(503, "app_transport_executor_unavailable", "The Butler runtime is unavailable."));
            }
            ready = self.dependencies.executor_readiness.wait_ready() => ready?,
        }
        Ok(())
    }

    async fn retry_view(&self, turn_id: String) -> Result<Value, GatewayApplicationError> {
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
        self.wait_retry_ready().await?;
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
            subsession_result: source.subsession_result,
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

/// Moves a retryable turn (a runtime fault or a crash interruption) at
/// `attempt` to retrying at the next attempt.
fn mark_retrying(
    db: &Connection,
    turn_id: &str,
    status_label: &str,
    cancellable: bool,
    attempt: u64,
    now: &str,
) -> Result<(), AppStorageError> {
    let changed = db
        .execute(
            "UPDATE turns SET state='retrying',safe_status_label=?1,\
             safe_status_label_key=NULL,safe_status_label_parameters_json=NULL,\
             safe_status_content_json=NULL,safe_error_code=NULL,retryable=0,\
             cancellable=?2,attempt=?3,updated_at=?4 \
             WHERE id=?5 AND retryable=1 AND attempt=?6 \
             AND (state='runtime_fault' OR (state='failed' AND safe_error_code=?7))",
            params![
                status_label,
                cancellable,
                attempt.saturating_add(1),
                now,
                turn_id,
                attempt,
                INTERRUPTED_TURN_CODE
            ],
        )
        .map_err(AppStorageError::sqlite)?;
    if changed == 1 {
        Ok(())
    } else {
        Err(not_retryable_error())
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
            "SELECT id FROM messages WHERE chat_id=?1 AND turn_id=?2 AND role='assistant' AND status<>'delivered' \
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
                &json!({"message_id":id,"chat_id":chat_id,"turn_id":turn_id,"role":"assistant"}),
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
    AppStorageError::new(AppStorageCode::TurnNotRetryable, "Turn is not retryable.")
}

fn queue_snapshot_error() -> AppStorageError {
    AppStorageError::new(
        AppStorageCode::TurnRetrySnapshotMissing,
        "Turn retry snapshot is unavailable.",
    )
}

fn execution_controls_error() -> AppStorageError {
    AppStorageError::new(
        AppStorageCode::TurnExecutionControlsMissing,
        "This legacy turn does not have an immutable execution snapshot and cannot be retried safely.",
    )
}

fn map_retry_error(error: AppStorageError) -> GatewayApplicationError {
    match error.code() {
        "turn_not_found" => public(404, error.code(), &error.detail()),
        "turn_not_retryable"
        | "turn_missing_user_message"
        | "turn_execution_controls_missing"
        | "turn_retry_snapshot_missing"
        | "turn_retry_dispatch_busy" => public(409, error.code(), &error.detail()),
        _ => app_error(error),
    }
}
