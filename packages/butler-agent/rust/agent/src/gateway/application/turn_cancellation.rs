use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use super::*;

impl AppApplication {
    pub(super) async fn recover_turn_cancellations(&self) -> Result<(), GatewayApplicationError> {
        let pending = self
            .storage
            .execute(|db| {
                let mut statement = db
                    .prepare(
                        "SELECT turns.chat_id,turns.id,outbox.created_at,q.claim_id FROM app_turn_cancel_outbox outbox JOIN turns ON turns.id=outbox.turn_id LEFT JOIN session_queued_messages q ON q.chat_id=turns.chat_id AND q.turn_id=turns.id AND q.state='dispatching' WHERE outbox.state='pending' AND outbox.queue_id IS NULL ORDER BY turns.rowid",
                    )
                    .map_err(AppStorageError::sqlite)?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    })
                    .map_err(AppStorageError::sqlite)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(AppStorageError::sqlite)?;
                Ok(rows)
            })
            .await
            .map_err(app_error)?;
        for (chat, turn, requested_at, claim) in pending {
            self.dispatch_cancel(chat, turn, requested_at, claim)
                .await?;
        }
        Ok(())
    }

    pub(super) async fn cancel_turn_owned(
        &self,
        turn_id: String,
    ) -> Result<Value, GatewayApplicationError> {
        let requested_at = self.dependencies.identity_clock.now_iso();
        let stored_at = requested_at.clone();
        let turn = turn_id.clone();
        let prepared = self
            .storage
            .execute(move |db| {
                let row = db
                    .query_row(
                        "SELECT chat_id,state,cancellable FROM turns WHERE id=?1",
                        [&turn],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, bool>(2)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(AppStorageError::sqlite)?
                    .ok_or_else(|| {
                        AppStorageError::new("turn_not_found", "Turn not found.")
                    })?;
                if row.1 == "cancelled" {
                    return Ok((row.0, None, true));
                }
                if (!row.2 && row.1 != "cancelling")
                    || matches!(row.1.as_str(), "delivered" | "failed" | "runtime_fault")
                {
                    return Err(AppStorageError::new(
                        "turn_not_cancellable",
                        "Turn is not cancellable.",
                    ));
                }
                let tx = db.transaction().map_err(AppStorageError::sqlite)?;
                tx.execute(
                    "UPDATE turns SET state='cancelling',safe_status_label='Stopping',safe_error_code=NULL,retryable=0,cancellable=0,updated_at=?1 WHERE id=?2 AND state NOT IN ('cancelled','delivered','failed','runtime_fault')",
                    params![stored_at, turn],
                )
                .map_err(AppStorageError::sqlite)?;
                tx.execute(
                    "INSERT INTO app_turn_cancel_outbox(turn_id,queue_id,dispatch_claim_id,state,created_at) VALUES(?1,NULL,NULL,'pending',?2) ON CONFLICT(turn_id) DO NOTHING",
                    params![turn, stored_at],
                )
                .map_err(AppStorageError::sqlite)?;
                let queued = tx
                    .query_row(
                        "SELECT queue_id FROM app_turn_cancel_outbox WHERE turn_id=?1",
                        [&turn],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .map_err(AppStorageError::sqlite)?;
                let claim = tx
                    .query_row(
                        "SELECT claim_id FROM session_queued_messages WHERE chat_id=?1 AND turn_id=?2 AND state='dispatching'",
                        params![row.0, turn],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map_err(AppStorageError::sqlite)?
                    .flatten();
                tx.commit().map_err(AppStorageError::sqlite)?;
                Ok((row.0, claim, queued.is_some()))
            })
            .await
            .map_err(app_error)?;
        if !prepared.2 {
            self.dispatch_cancel(
                prepared.0.clone(),
                turn_id.clone(),
                requested_at,
                prepared.1,
            )
            .await?;
        }
        let turn = self
            .storage
            .execute(move |db| read_model::exact_turn(db, &turn_id))
            .await
            .map_err(app_error)?
            .ok_or_else(|| public(404, "turn_not_found", "Turn not found."))?;
        Ok(json!({"turn":turn,"replies":[],"next_cursor":0}))
    }

    async fn dispatch_cancel(
        &self,
        chat_id: String,
        turn_id: String,
        requested_at: String,
        app_queue_claim_id: Option<String>,
    ) -> Result<(), GatewayApplicationError> {
        let receipt = self
            .dependencies
            .native_ingress
            .enqueue_cancel(NativeAppCancellation {
                session_id: app_session_hint(&chat_id),
                chat_id,
                request_id: format!("cancel:{turn_id}"),
                turn_id: turn_id.clone(),
                requested_at,
                app_queue_claim_id,
            })
            .await?;
        self.storage
            .execute(move |db| {
                db.execute(
                    "UPDATE app_turn_cancel_outbox SET queue_id=?1 WHERE turn_id=?2 AND state='pending' AND queue_id IS NULL",
                    params![receipt.queue_id, turn_id],
                )
                .map_err(AppStorageError::sqlite)?;
                Ok(())
            })
            .await
            .map_err(app_error)
    }
}
