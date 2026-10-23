//! The new native runtime fences legacy mutations on its owning connection.
//! The fence is connection-local: older binaries can still write their source
//! tables, and their seven existing feed triggers drive downgrade reconciliation.
pub(super) mod admission;
pub(super) mod transcript;
use super::{BtccStorage, StorageError, StorageResult};
use crate::btcc::ProjectWorkObserveWorks;
use rusqlite::{
    Connection,
    hooks::{AuthAction, AuthContext, Authorization},
};

pub(super) fn fence(db: &Connection) {
    db.authorizer(Some(|context: AuthContext<'_>| {
        let (AuthAction::Insert { table_name: table }
        | AuthAction::Update {
            table_name: table, ..
        }
        | AuthAction::Delete { table_name: table }) = context.action
        else {
            return Authorization::Allow;
        };
        if table.starts_with("btcc_guided_work")
            || matches!(
                table,
                "btcc_guided_turn_work_bindings"
                    | "btcc_subsession_delegations"
                    | "btcc_subsession_directions"
                    | "btcc_steward_results"
            )
        {
            Authorization::Deny
        } else {
            Authorization::Allow
        }
    }));
    db.flush_prepared_statement_cache();
}
impl BtccStorage {
    /// Low-space status is process-local. Only frozen inventory/estimate
    /// metadata persists before a successful free-space precheck.
    pub fn postpone_work_model_cutover(&self) {
        if !self
            .inner
            .cutover_postponed
            .swap(true, std::sync::atomic::Ordering::Relaxed)
        {
            self.inner.changes.send_replace(());
        }
    }
    pub async fn work_model_cutover_status(
        &self,
    ) -> StorageResult<butler_work::cutover::CutoverStatus> {
        let mut status = self.work_model_read(butler_work::cutover::status).await?;
        if status.state != butler_work::cutover::CutoverState::Done
            && self
                .inner
                .cutover_postponed
                .load(std::sync::atomic::Ordering::Relaxed)
        {
            status.state = butler_work::cutover::CutoverState::PostponedNoSpace;
        }
        Ok(status)
    }
    pub async fn fence_legacy_work_writers(&self) -> StorageResult<()> {
        self.execute(|db| {
            fence(db);
            Ok(())
        })
        .await
    }
    /// Only the startup importer calls this; normal projection writes never
    /// bypass the fence. Observation closes permanently at the epoch switch.
    pub async fn observe_work_model_cutover(
        &self,
        input: ProjectWorkObserveWorks,
    ) -> StorageResult<()> {
        self.execute(move |db| {
            let epoch: i64 = db
                .query_row(butler_work::cutover::EPOCH, [], |r| r.get(0))
                .map_err(StorageError::sqlite)?;
            if epoch != 0 {
                return Err(StorageError::Port {
                    code: "work_cutover_observation_closed",
                    message: "Work cutover observation is closed".into(),
                    source: None,
                });
            }
            db.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
            let result = (|| {
                let tx = db.transaction().map_err(StorageError::sqlite)?;
                super::project_work_runtime::observe_for_cutover(&tx, &input)?;
                tx.commit().map_err(StorageError::sqlite)
            })();
            fence(db);
            result
        })
        .await
    }
}

/// A managed receipt remains pending on shutdown or lack of backup space.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CutoverAdmission {
    Ready(String),
    Pending(String),
}
impl BtccStorage {
    /// Persist the managed request and release the turn while cutover owns it.
    /// The change-driven receipt consumer resumes it after the epoch switch.
    pub async fn admit_work_model(
        &self,
        input: butler_work::cutover::ManagedAdmission,
        stop: &tokio_util::sync::CancellationToken,
    ) -> StorageResult<CutoverAdmission> {
        let (id, ready) = self
            .work_model_write(move |tx| admission::admit(tx, &input))
            .await?;
        if !stop.is_cancelled() && ready {
            Ok(CutoverAdmission::Ready(id))
        } else {
            Ok(CutoverAdmission::Pending(id))
        }
    }
}
