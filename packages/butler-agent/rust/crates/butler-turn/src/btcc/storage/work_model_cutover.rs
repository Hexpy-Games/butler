//! The new native runtime fences legacy mutations on its owning connection.
//! The fence is connection-local: older binaries can still write their source
//! tables, and their seven existing feed triggers drive downgrade reconciliation.
use super::{BtccStorage, StorageError, StorageResult};
use crate::btcc::ProjectWorkObserveWorks;
use rusqlite::{
    Connection,
    hooks::{AuthAction, AuthContext, Authorization},
};

pub(super) fn fence(db: &Connection) {
    db.authorizer(Some(|context: AuthContext<'_>| {
        let table = match context.action {
            AuthAction::Insert { table_name }
            | AuthAction::Update { table_name, .. }
            | AuthAction::Delete { table_name } => table_name,
            _ => return Authorization::Allow,
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
    /// Admission boundary for Task runtime: persist receipt, prioritize this
    /// session's import, then wait on changes. No timer or legacy fallback.
    pub async fn admit_work_model(
        &self,
        input: butler_work::cutover::ManagedAdmission,
        stop: &tokio_util::sync::CancellationToken,
    ) -> StorageResult<CutoverAdmission> {
        use butler_work::cutover::{self, CutoverState};
        let mut changes = self.subscribe_changes();
        let session = input.session_id.clone();
        let id = self
            .work_model_write(move |tx| butler_work::cutover::accept(tx, &input))
            .await?;
        let mut cursor = String::new();
        let mut imported = false;
        loop {
            if stop.is_cancelled() {
                return Ok(CutoverAdmission::Pending(id));
            }
            changes.borrow_and_update();
            let state = self.work_model_read(cutover::status).await?.state;
            match state {
                CutoverState::Done => return Ok(CutoverAdmission::Ready(id)),
                CutoverState::PostponedNoSpace => return Ok(CutoverAdmission::Pending(id)),
                CutoverState::Importing if !imported => {
                    let session = session.clone();
                    let after = cursor.clone();
                    if let Some(next) = self
                        .work_model_write(move |tx| {
                            let ctx = butler_work::store::Context {
                                now: chrono::Utc::now().timestamp_millis(),
                                actor: serde_json::json!({"origin":"migration"}),
                            };
                            cutover::session_batch(tx, &ctx, &session, &after)
                        })
                        .await?
                    {
                        cursor = next;
                        continue;
                    }
                    imported = true;
                    continue;
                }
                CutoverState::Pending | CutoverState::BackingUp | CutoverState::Importing => {}
            }
            tokio::select! {
                _ = stop.cancelled() => return Ok(CutoverAdmission::Pending(id)),
                changed = changes.changed() => if changed.is_err() { return Ok(CutoverAdmission::Pending(id)); },
            }
        }
    }
}
