//! Send the next queued user input through the ordinary cancel and FIFO paths.
use rusqlite::OptionalExtension;

use super::super::{app_error, queue, queue_dispatcher, queue_view, turn_cancellation};
use super::support::storage_not_found;
use super::{AppApplication, AppStorageError, GatewayApplicationError, SessionQueueView};
use crate::gateway::application::storage::AppStorageCode;
use turn_cancellation::{QueueAfterCancel, prepare_cancel};

struct SendNow {
    chat: String,
    cancel: Option<(String, Option<String>, bool)>,
    wake: bool,
}

impl AppApplication {
    pub(in crate::gateway::application) fn send_session_queue_now_owned(
        &self,
        queued_message_id: String,
    ) -> crate::gateway::ApplicationFuture<SessionQueueView> {
        let owner = self.queue_mutations.clone();
        let application = self.clone_handle();
        Box::pin(async move {
            owner
                .run(Box::pin(async move {
                    application
                        .send_session_queue_now_inner(queued_message_id)
                        .await
                }))
                .await
        })
    }

    async fn send_session_queue_now_inner(
        &self,
        queued_message_id: String,
    ) -> Result<SessionQueueView, GatewayApplicationError> {
        let now = self.dependencies.identity_clock.now_iso();
        let stored_at = now.clone();
        let prepared = self
            .storage
            .execute(move |db| prepare_send_now(db, &queued_message_id, &stored_at))
            .await
            .map_err(app_error)?;
        if let Some((turn, claim, sent)) = prepared.cancel {
            if sent {
                self.settle_confirmed_stop(prepared.chat.clone(), turn)
                    .await?;
            } else {
                self.dispatch_cancel(prepared.chat.clone(), turn, now, claim)
                    .await?;
            }
        }
        if prepared.wake {
            self.queue_wake.chat(prepared.chat.clone()).await?;
        }
        self.queue_page(prepared.chat).await
    }
}

fn prepare_send_now(
    db: &mut rusqlite::Connection,
    id: &str,
    now: &str,
) -> Result<SendNow, AppStorageError> {
    let mut tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    let row = queue_view::mutation_row(&tx, id)?.ok_or_else(storage_not_found)?;
    if matches!(row.state.as_str(), "dispatching" | "dispatched") {
        return Ok(SendNow {
            chat: row.chat_id,
            cancel: None,
            wake: false,
        });
    }
    if row.state != "queued" {
        return Err(storage_not_found());
    }
    let next: Option<String> = tx
        .query_row(
            "SELECT id FROM session_queued_messages WHERE chat_id=?1 AND state='queued' \
         AND NOT (CASE WHEN json_valid(control_resolution_json) THEN \
           json_type(control_resolution_json,'$.subsession_result') IS 'object' ELSE 0 END) \
         ORDER BY rowid LIMIT 1",
            [&row.chat_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if next.as_deref() != Some(id) {
        return Err(AppStorageError::new(
            AppStorageCode::QueuedMessageNotNext,
            "This message is not next in the session queue.",
        ));
    }
    let active = queue_dispatcher::active_turn(&tx, &row.chat_id)?;
    queue::resume(&tx, &row.chat_id)?;
    let cancel = active
        .map(
            |turn| match prepare_cancel(&mut tx, &turn, now, QueueAfterCancel::KeepRunning) {
                Ok((_, claim, sent)) => Ok(Some((turn, claim, sent))),
                Err(error) if error.code() == "turn_not_cancellable" => Ok(None),
                Err(error) => Err(error),
            },
        )
        .transpose()?
        .flatten();
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(SendNow {
        chat: row.chat_id,
        cancel,
        wake: true,
    })
}
