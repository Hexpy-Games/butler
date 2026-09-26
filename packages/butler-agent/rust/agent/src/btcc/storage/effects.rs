//! Guided effect journal on the existing serialized BTCC SQLite owner.

mod blocker;
mod receipt_json;
mod row;
mod write;

use rusqlite::OptionalExtension;
use std::sync::Arc;

use crate::btcc::effects::contracts::*;

use super::BtccStorage;

#[derive(Clone)]
pub(crate) struct StorageEffectJournal {
    storage: BtccStorage,
    clock: Arc<dyn Fn() -> String + Send + Sync>,
}
impl StorageEffectJournal {
    pub(crate) fn new(storage: BtccStorage, clock: Arc<dyn Fn() -> String + Send + Sync>) -> Self {
        Self { storage, clock }
    }

    /// Claim only an applied restart request. A crash after this claim remains
    /// uncertain; the next service never blindly replays the handoff.
    pub(crate) async fn claim_restart_handoff(
        &self,
        key: String,
        receipt: String,
    ) -> EffectResult<bool> {
        self.storage
            .execute(move |db| {
                db.execute(
                    "UPDATE btcc_guided_effects SET handoff_state='claimed' \
                     WHERE idempotency_key=?1 AND receipt_id=?2 \
                     AND capability='request_service_restart' \
                     AND status='applied' AND handoff_state IS NULL",
                    rusqlite::params![key, receipt],
                )
                .map(|changed| changed == 1)
                .map_err(super::StorageError::sqlite)
            })
            .await
            .map_err(outer)
    }

    pub(crate) async fn record_restart_handoff(
        &self,
        key: String,
        state: &'static str,
    ) -> EffectResult<()> {
        if !matches!(state, "spawned" | "spawn_failed") {
            return Err(EffectFailure::policy(
                "restart_handoff_state_invalid",
                "Invalid restart handoff state",
            ));
        }
        self.storage
            .execute(move |db| {
                db.execute(
                    "UPDATE btcc_guided_effects SET handoff_state=?2, \
                     handoff_error=CASE WHEN ?2='spawn_failed' \
                     THEN 'restart_handoff_spawn_failed' ELSE NULL END \
                     WHERE idempotency_key=?1 AND capability='request_service_restart' \
                     AND handoff_state='claimed'",
                    rusqlite::params![key, state],
                )
                .and_then(|changed| {
                    if changed == 1 {
                        return Ok(());
                    }
                    let current: Option<String> = db
                        .query_row(
                            "SELECT handoff_state FROM btcc_guided_effects WHERE idempotency_key=?1 AND capability='request_service_restart'",
                            [&key],
                            |row| row.get(0),
                        )
                        .optional()?;
                    if current.as_deref().is_some_and(terminal_restart_state) {
                        Ok(())
                    } else {
                        Err(rusqlite::Error::QueryReturnedNoRows)
                    }
                })
                .map_err(super::StorageError::sqlite)
            })
            .await
            .map_err(outer)
    }

    /// A helper reports its outcome through the current serialized BTCC owner.
    /// The CAS also handles a fast helper finishing before its parent writes `spawned`.
    pub(crate) async fn finish_restart_handoff(
        &self,
        key: String,
        state: &'static str,
    ) -> EffectResult<()> {
        if !terminal_restart_state(state) {
            return Err(EffectFailure::policy(
                "restart_handoff_state_invalid",
                "Invalid restart handoff outcome",
            ));
        }
        self.storage
            .execute(move |db| {
                db.execute(
                    "UPDATE btcc_guided_effects SET handoff_state=?2, \
                     handoff_error=CASE WHEN ?2='ready' THEN NULL ELSE ?2 END \
                     WHERE idempotency_key=?1 AND capability='request_service_restart' \
                     AND status='applied' AND handoff_state IN ('claimed','spawned')",
                    rusqlite::params![key, state],
                )
                .and_then(|changed| {
                    if changed == 1 {
                        return Ok(());
                    }
                    let current: Option<String> = db
                        .query_row(
                            "SELECT handoff_state FROM btcc_guided_effects WHERE idempotency_key=?1 AND capability='request_service_restart'",
                            [&key],
                            |row| row.get(0),
                        )
                        .optional()?;
                    if current.as_deref() == Some(state) {
                        Ok(())
                    } else {
                        Err(rusqlite::Error::QueryReturnedNoRows)
                    }
                })
                .map_err(super::StorageError::sqlite)
            })
            .await
            .map_err(outer)
    }
}
fn terminal_restart_state(state: &str) -> bool {
    matches!(
        state,
        "ready"
            | "target_gone"
            | "target_changed"
            | "stop_failed"
            | "start_failed"
            | "start_unverified"
            | "precondition_failed"
    )
}
fn outer(error: super::StorageError) -> EffectFailure {
    EffectFailure::storage(error.code, error.message)
}
fn inner<T: Send + 'static>(result: EffectResult<T>) -> super::StorageResult<EffectResult<T>> {
    Ok(result)
}

impl EffectJournal for StorageEffectJournal {
    fn prepare(
        &self,
        identity: EffectIdentity,
        recovery: Option<RecoveryHint>,
    ) -> EffectFuture<'_, PrepareEffect> {
        let storage = self.storage.clone();
        let clock = self.clock.clone();
        Box::pin(async move {
            storage
                .execute(move |db| inner(write::prepare(db, &identity, recovery.as_ref(), &*clock)))
                .await
                .map_err(outer)?
        })
    }
    fn find(&self, effect_id: String) -> EffectFuture<'_, Option<EffectRecord>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(move |db| inner(row::find(db, &effect_id)))
                .await
                .map_err(outer)?
        })
    }
    fn list_for_work(
        &self,
        work_id: String,
        limit: Option<f64>,
    ) -> EffectFuture<'_, Vec<EffectRecord>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(move |db| inner(row::list_for_work(db, &work_id, limit)))
                .await
                .map_err(outer)?
        })
    }
    fn blockers(&self, work_id: String) -> EffectFuture<'_, Vec<EffectBlocker>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(move |db| inner(blocker::list(db, &work_id)))
                .await
                .map_err(outer)?
        })
    }
    fn resolve_blockers(
        &self,
        work_id: String,
        occurrence: String,
        resolution: String,
    ) -> EffectFuture<'_, bool> {
        let storage = self.storage.clone();
        let clock = self.clock.clone();
        Box::pin(async move {
            storage
                .execute(move |db| {
                    inner(blocker::resolve(
                        db,
                        &work_id,
                        &occurrence,
                        &resolution,
                        &*clock,
                    ))
                })
                .await
                .map_err(outer)?
        })
    }
    fn claim_dispatch(
        &self,
        effect_id: String,
        revision: i64,
    ) -> EffectFuture<'_, Option<EffectRecord>> {
        let storage = self.storage.clone();
        let clock = self.clock.clone();
        Box::pin(async move {
            storage
                .execute(move |db| inner(write::claim(db, &effect_id, revision, &*clock)))
                .await
                .map_err(outer)?
        })
    }
    fn return_prepared(
        &self,
        effect_id: String,
        revision: i64,
    ) -> EffectFuture<'_, Option<EffectRecord>> {
        let storage = self.storage.clone();
        let clock = self.clock.clone();
        Box::pin(async move {
            storage
                .execute(move |db| inner(write::return_prepared(db, &effect_id, revision, &*clock)))
                .await
                .map_err(outer)?
        })
    }
    fn record_applied(
        &self,
        effect_id: String,
        revision: i64,
        result: crate::json::JsonDocument,
        receipt: EffectReceipt,
    ) -> EffectFuture<'_, Option<EffectRecord>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(move |db| {
                    inner(write::record_applied(
                        db, &effect_id, revision, &result, &receipt,
                    ))
                })
                .await
                .map_err(outer)?
        })
    }
    fn record_uncertain(
        &self,
        effect_id: String,
        revision: i64,
        error: EffectError,
    ) -> EffectFuture<'_, Option<EffectRecord>> {
        let storage = self.storage.clone();
        let clock = self.clock.clone();
        Box::pin(async move {
            storage
                .execute(move |db| {
                    inner(write::record_error(
                        db, &effect_id, revision, &error, false, &*clock,
                    ))
                })
                .await
                .map_err(outer)?
        })
    }
    fn record_failed(
        &self,
        effect_id: String,
        revision: i64,
        error: EffectError,
    ) -> EffectFuture<'_, Option<EffectRecord>> {
        let storage = self.storage.clone();
        let clock = self.clock.clone();
        Box::pin(async move {
            storage
                .execute(move |db| {
                    inner(write::record_error(
                        db, &effect_id, revision, &error, true, &*clock,
                    ))
                })
                .await
                .map_err(outer)?
        })
    }
}
