//! Change-driven, FIFO worker admission. Clones share the check/enqueue/mark gate.
use super::*;
use crate::btcc::storage::native_sql;
use rusqlite::OptionalExtension;

impl SubsessionService {
    pub(super) async fn dispatch_or_wait(&self, child: &Child) -> Result<Option<u32>, BtccError> {
        if child.packet.child_role != ChildRole::Worker {
            let _gate = self.dispatch_gate.lock().await;
            self.replay(child).await?;
            return Ok(None);
        }
        self.release_worker_slot(&child.parent_session_id)
            .await
            .map(Some)
    }

    pub(super) async fn release_worker_slot(&self, parent: &str) -> Result<u32, BtccError> {
        let cap = self.profiles.max_simultaneous().await?.clamp(1, 10);
        let _gate = self.dispatch_gate.lock().await;
        self.drain_workers(parent, cap).await?;
        Ok(cap)
    }

    async fn drain_workers(&self, parent: &str, cap: u32) -> Result<(), BtccError> {
        loop {
            let parent = parent.to_owned();
            let next = self
                .repository
                .storage()
                .work_model_read(move |db| {
                    let running: u32 =
                        db.query_row(native_sql::WORKER_RUNNING_COUNT, [&parent], |r| r.get(0))?;
                    if running >= cap {
                        return Ok(None);
                    }
                    Ok(db
                        .query_row(native_sql::WORKER_NEXT_WAITING, [parent], |r| {
                            r.get::<_, String>(0)
                        })
                        .optional()?)
                })
                .await
                .map_err(BtccError::from)?;
            let Some(session) = next else {
                return Ok(());
            };
            let child = self
                .repository
                .by_child(session)
                .await
                .map_err(BtccError::from)?
                .ok_or_else(|| error(BtccCode::SubsessionRelationMissing))?;
            self.ensure_child_binding(&child).await?;
            self.replay(&child).await?;
            self.notify_execution_changed(&child.child_session_id)
                .await?;
        }
    }

    pub(super) async fn worker_output(
        &self,
        child: &Child,
        cap: Option<u32>,
    ) -> Result<Value, BtccError> {
        let mut output = delegation_output(child);
        if let Some(cap) = cap
            && self.dispatch_pending(child).await?
        {
            let fields = butler_core::json::object_mut(&mut output);
            fields.insert("status".into(), json!("waiting"));
            fields.insert("message".into(), json!(format!(
                "Worker {} is waiting because this session already has {cap} Workers running. It starts automatically when one of them finishes, and its result arrives like any other. Continue your own work and do not dispatch it again.",
                child.delegation_id
            )));
        }
        Ok(output)
    }

    pub(super) async fn dispatch_pending(&self, child: &Child) -> Result<bool, BtccError> {
        let Child::Assigned(assigned) = child else {
            return Ok(false);
        };
        let op = format!("child_dispatch:{}", assigned.attempt_id);
        self.repository
            .storage()
            .work_model_read(move |db| {
                Ok(db.query_row(native_sql::WORKER_DISPATCH_PENDING, [op], |r| r.get(0))?)
            })
            .await
            .map_err(BtccError::from)
    }

    /// A waiting child has no transport turn to cancel. Settle its intent and
    /// lease atomically before publishing its ordinary cancelled result.
    pub(super) async fn cancel_waiting(&self, child: &Child) -> Result<bool, BtccError> {
        let Child::Assigned(assigned) = child else {
            return Ok(false);
        };
        let cancelled = {
            let _gate = self.dispatch_gate.lock().await;
            let attempt = assigned.attempt_id.clone();
            let part = assigned.part_id.clone();
            self.repository
                .storage()
                .work_model_write(move |tx| {
                    let op = format!("child_dispatch:{attempt}");
                    let pending: bool =
                        tx.query_row(native_sql::WORKER_DISPATCH_PENDING, [&op], |r| r.get(0))?;
                    if !pending {
                        return Ok(false);
                    }
                    let ctx = admission::context();
                    tx.execute(
                        butler_work::store::execution_sql::FINISH_ATTEMPT,
                        rusqlite::params![attempt, "interrupted", ctx.now, "cancelled"],
                    )?;
                    if let Some(part) = part {
                        tx.execute(
                            butler_work::store::execution_sql::PART_STATE,
                            rusqlite::params![part, "cancelled", Option::<&str>::None],
                        )?;
                    }
                    butler_work::store::mark_intent_applied(tx, &ctx, &op, 0)?;
                    Ok(true)
                })
                .await
                .map_err(BtccError::from)?
        };
        if cancelled {
            self.complete_child(
                &child.child_session_id,
                &child.child_turn_id,
                "cancelled",
                "cancelled".into(),
            )
            .await?;
        }
        Ok(cancelled)
    }
}
