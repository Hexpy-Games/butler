use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use super::*;
use crate::gateway::application::storage::AppStorageCode;

/// Sent Stops still waiting for their outcome; served by
/// `app_turn_cancel_outbox_pending_idx`.
pub(super) const SENT_CANCELS_SQL: &str = "SELECT turns.chat_id,turns.id FROM app_turn_cancel_outbox outbox \
    JOIN turns ON turns.id=outbox.turn_id WHERE outbox.state IN ('pending','accepted') \
    AND outbox.queue_id IS NOT NULL AND turns.state='cancelling'";
const SENT_CANCEL_SQL: &str = "SELECT 1 FROM app_turn_cancel_outbox outbox \
    JOIN turns ON turns.id=outbox.turn_id WHERE outbox.turn_id=?1 AND turns.chat_id=?2 \
    AND outbox.state IN ('pending','accepted') AND outbox.queue_id IS NOT NULL \
    AND turns.state='cancelling'";

#[derive(Clone, Copy)]
pub(super) enum QueueAfterCancel {
    Pause,
    KeepRunning,
}

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
        let sent = self
            .storage
            .read(|db| {
                let mut statement = db
                    .prepare_cached(SENT_CANCELS_SQL)
                    .map_err(AppStorageError::sqlite)?;
                let rows = statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                    .map_err(AppStorageError::sqlite)?;
                rows.collect::<Result<Vec<(String, String)>, _>>()
                    .map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        for (chat, turn) in sent {
            self.settle_confirmed_stop(chat, turn).await?;
        }
        Ok(())
    }

    /// Settles a sent Stop the App is still waiting on once BTCC confirmed it
    /// (an acknowledgement an earlier version dropped, or a Stop pressed again).
    pub(super) async fn settle_confirmed_stop(
        &self,
        chat_id: String,
        turn_id: String,
    ) -> Result<(), GatewayApplicationError> {
        let confirmed = self
            .dependencies
            .native_ingress
            .stop_confirmed(turn_id.clone())
            .await?;
        if !confirmed {
            return Ok(());
        }
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        let chat = chat_id.clone();
        let settled = self
            .storage
            .execute(move |db| {
                let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
                let waiting = tx
                    .query_row(SENT_CANCEL_SQL, params![turn_id, chat], |_| Ok(()))
                    .optional()
                    .map_err(AppStorageError::sqlite)?
                    .is_some();
                if waiting {
                    projection::settle_confirmed_stop(&tx, &subscribers, &chat, &turn_id, &now)?;
                }
                tx.commit().map_err(AppStorageError::sqlite)?;
                Ok(waiting)
            })
            .await
            .map_err(app_error)?;
        if settled {
            self.queue_wake.chat(chat_id).await?;
            if self
                .automation_queued
                .load(std::sync::atomic::Ordering::Acquire)
            {
                self.automation_wake.notify_one();
            }
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
                let mut tx = db.savepoint().map_err(AppStorageError::sqlite)?;
                let prepared = prepare_cancel(&mut tx, &turn, &stored_at, QueueAfterCancel::Pause)?;
                tx.commit().map_err(AppStorageError::sqlite)?;
                Ok(prepared)
            })
            .await
            .map_err(app_error)?;
        if prepared.2 {
            self.settle_confirmed_stop(prepared.0.clone(), turn_id.clone())
                .await?;
        } else {
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

    pub(super) async fn dispatch_cancel(
        &self,
        chat_id: String,
        turn_id: String,
        requested_at: String,
        app_queue_claim_id: Option<String>,
    ) -> Result<(), GatewayApplicationError> {
        let receipt = self
            .dependencies
            .native_ingress
            .enqueue_cancel(AppCancellation {
                session_id: self.runtime_hint(&chat_id).await?,
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

pub(super) fn prepare_cancel(
    db: &mut rusqlite::Savepoint<'_>,
    turn: &str,
    stored_at: &str,
    queue_after: QueueAfterCancel,
) -> Result<(String, Option<String>, bool), AppStorageError> {
    let row = db
        .query_row(
            "SELECT chat_id,state,cancellable FROM turns WHERE id=?1",
            [turn],
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
        .ok_or_else(|| AppStorageError::new(AppStorageCode::TurnNotFound, "Turn not found."))?;
    if row.1 == "cancelled" {
        return Ok((row.0, None, true));
    }
    if (!row.2 && row.1 != "cancelling")
        || matches!(row.1.as_str(), "delivered" | "failed" | "runtime_fault")
    {
        return Err(AppStorageError::new(
            AppStorageCode::TurnNotCancellable,
            "Turn is not cancellable.",
        ));
    }
    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    mark_cancelling(&tx, &row.0, turn, stored_at, queue_after)?;
    let queued = tx
        .query_row(
            "SELECT queue_id FROM app_turn_cancel_outbox WHERE turn_id=?1",
            [turn],
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
}

/// Marks the turn cancelling and queues its cancel through the shared outbox.
fn mark_cancelling(
    tx: &rusqlite::Savepoint<'_>,
    chat_id: &str,
    turn_id: &str,
    now: &str,
    queue_after: QueueAfterCancel,
) -> Result<(), AppStorageError> {
    tx.execute(
        "UPDATE turns SET state='cancelling',safe_status_label='Stopping',safe_error_code=NULL,retryable=0,cancellable=0,updated_at=?1 WHERE id=?2 AND state NOT IN ('cancelled','delivered','failed','runtime_fault')",
        params![now, turn_id],
    )
    .map_err(AppStorageError::sqlite)?;
    tx.execute(
        "INSERT INTO app_turn_cancel_outbox(turn_id,queue_id,dispatch_claim_id,state,created_at) VALUES(?1,NULL,NULL,'pending',?2) ON CONFLICT(turn_id) DO NOTHING",
        params![turn_id, now],
    )
    .map_err(AppStorageError::sqlite)?;
    match queue_after {
        QueueAfterCancel::Pause => queue::pause(tx, chat_id, turn_id, now),
        QueueAfterCancel::KeepRunning => queue::resume(tx, chat_id),
    }
}
