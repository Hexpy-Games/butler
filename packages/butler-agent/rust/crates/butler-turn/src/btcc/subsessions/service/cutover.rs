//! Cutover receipts resume on storage changes; no turn waits on the importer.
use super::*;
use butler_work::{cutover::CutoverState, store};
use tokio_util::sync::CancellationToken;
impl SubsessionService {
    pub async fn replay_kept_requests(&self, stop: CancellationToken) -> Result<(), BtccError> {
        let storage = self.repository.storage();
        let mut changes = storage.subscribe_changes();
        loop {
            changes.borrow_and_update();
            if stop.is_cancelled() {
                return Ok(());
            }
            if storage
                .work_model_cutover_status()
                .await
                .map_err(BtccError::from)?
                .state
                == CutoverState::Done
            {
                tokio::select! {
                    () = stop.cancelled() => return Ok(()),
                    result = self.replay_ready_requests() => result?,
                }
            }
            tokio::select! {
                ()=stop.cancelled()=>return Ok(()),
                changed=changes.changed()=>if changed.is_err() {return Ok(())},
            }
        }
    }
    async fn replay_ready_requests(&self) -> Result<(), BtccError> {
        let storage = self.repository.storage();
        let pending = storage
            .work_model_read(|db| {
                let mut stmt =
                    db.prepare(crate::btcc::storage::native_sql::SUBSESSIONS_SERVICE_CUTOVER_1)?;
                Ok(stmt
                    .query_map([], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
            .map_err(BtccError::from)?;
        for (op, revision, instruction, event) in pending {
            self.queue
                .replay_kept_request(event, instruction.clone())
                .await?;
            storage
                .work_model_write(move |tx| {
                    store::deliver_instruction(
                        tx,
                        &admission::context(),
                        &instruction,
                        "waiting_for_turn",
                    )?;
                    store::mark_intent_applied(tx, &admission::context(), &op, revision)?;
                    Ok(())
                })
                .await
                .map_err(BtccError::from)?;
        }
        Ok(())
    }
}
