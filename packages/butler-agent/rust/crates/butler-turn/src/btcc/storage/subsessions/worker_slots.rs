//! Per-parent Worker admission on the SQLite writer lane.
use super::*;

pub(super) const FIRST_ENDED: &str = "SELECT EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.child_turn_id=d.child_turn_id AND x.relation_id=d.relation_id AND x.status<>'cancelled') FROM btcc_subsession_delegations d WHERE d.relation_id=?1 AND d.dispatch_state='enqueued'";

const PENDING: &str = "SELECT relation_id FROM btcc_subsession_delegations WHERE parent_session_id=?1 AND child_role='worker' AND dispatch_state='pending' ORDER BY created_at,rowid LIMIT 1";
const RUNNING: &str = "SELECT count(*) FROM btcc_subsession_delegations WHERE parent_session_id=?1 AND child_role='worker' AND dispatch_state='enqueued'";

impl SqliteSubsessionRepository {
    /// Reserve a slot for the oldest pending Worker. The transaction commits
    /// before the caller touches the foreign queue store. Enqueued rows are
    /// replayed idempotently at startup if enqueue fails or the process exits.
    pub(crate) async fn admit_worker(
        &self,
        parent: String,
        cap: u64,
    ) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
        self.storage.execute(move |db| {
            let tx = db.transaction().map_err(StorageError::sqlite)?;
            let running: u64 = tx.query_row(RUNNING, [&parent], |r| r.get(0))
                .map_err(StorageError::sqlite)?;
            if running >= cap { return Ok(None); }
            let next: Option<String> = tx.query_row(PENDING, [&parent], |r| r.get(0))
                .optional().map_err(StorageError::sqlite)?;
            let Some(id) = next else { return Ok(None); };
            tx.execute("UPDATE btcc_subsession_delegations SET dispatch_state='enqueued' WHERE relation_id=?1", [&id])
                .map_err(StorageError::sqlite)?;
            let stored = read(&tx, "r.relation_id=?1", &id)?;
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(stored)
        }).await
    }

    pub(crate) async fn enqueued_workers(
        &self,
    ) -> Result<Vec<StoredSubsessionDelegation>, StorageError> {
        self.storage.read(|db| {
            decode::list(db, "WHERE d.dispatch_state='enqueued' AND d.child_role='worker' ORDER BY d.created_at,d.rowid", [])
        }).await
    }

    /// A waiting Worker's direction cannot create its first execution turn.
    pub(crate) async fn worker_first_turn_ended(
        &self,
        relation: String,
    ) -> Result<bool, StorageError> {
        self.storage
            .read(move |db| {
                db.query_row(FIRST_ENDED, [relation], |r| r.get(0))
                    .optional()
                    .map(|ended| ended.unwrap_or(false))
                    .map_err(StorageError::sqlite)
            })
            .await
    }
}
