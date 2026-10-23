//! Worker admission derived from durable execution, on the BTCC writer lane.
use super::*;

pub(super) const FIRST_ENDED: &str =
    "SELECT EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=?1)";

pub const WORKER_RESULT_MARKER_SQL: &str =
    "SELECT result_id FROM btcc_steward_results WHERE relation_id=?1 ORDER BY rowid DESC LIMIT 1";
pub const RETRY_WORKER_SQL: &str = "UPDATE btcc_subsession_delegations SET dispatch_state='pending' WHERE relation_id=?1 AND dispatch_state='enqueued' AND (SELECT result_id FROM btcc_steward_results WHERE relation_id=?1 ORDER BY rowid DESC LIMIT 1) IS ?2";

pub const RUNNING_WORKERS_SQL: &str = "SELECT count(*) FROM btcc_subsession_delegations d
 JOIN btcc_session_relations r ON r.relation_id=d.relation_id
 WHERE r.parent_session_id=?1 AND r.activity_role='worker' AND (
   EXISTS (SELECT 1 FROM btcc_turns t WHERE t.session_id=r.child_session_id
     AND t.semantic_state IN ('admitted','delivery_committed') AND NOT EXISTS (
       SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=d.relation_id AND x.child_turn_id=t.turn_id))
   OR (d.dispatch_state='enqueued' AND (
     NOT EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=d.relation_id)
     OR EXISTS (SELECT 1 FROM btcc_subsession_directions i WHERE i.relation_id=d.relation_id AND i.status='pending'))))";

// A continuation joins the same FIFO at its own creation, never at the original
// dispatch's historical timestamp. Candidates use the parent and pending indexes.
pub const WAITING_WORKERS_SQL: &str = "SELECT d.relation_id FROM btcc_session_relations r
 JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id
 LEFT JOIN btcc_subsession_directions i ON i.instruction_id=(
   SELECT instruction_id FROM btcc_subsession_directions WHERE relation_id=d.relation_id AND status='pending' ORDER BY revision LIMIT 1)
 WHERE r.parent_session_id=?1 AND r.activity_role='worker' AND d.dispatch_state='pending'
 AND NOT EXISTS (SELECT 1 FROM btcc_turns t WHERE t.session_id=r.child_session_id
   AND NOT EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=d.relation_id AND x.child_turn_id=t.turn_id))
 ORDER BY CASE WHEN EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=d.relation_id) THEN i.created_at ELSE d.created_at END,
 CASE WHEN EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=d.relation_id) THEN i.rowid ELSE d.rowid END,d.rowid LIMIT 1";

impl SqliteSubsessionRepository {
    /// Read-pool counterpart of the admission transaction's derived count.
    pub async fn running_worker_count(&self, parent: String) -> Result<u64, StorageError> {
        self.storage
            .read(move |db| {
                db.query_row(RUNNING_WORKERS_SQL, [parent], |r| r.get(0))
                    .map_err(StorageError::sqlite)
            })
            .await
    }

    pub(crate) async fn admit_worker(
        &self,
        parent: String,
        cap: u64,
    ) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
        self.storage.execute(move |db| {
            let tx = db.transaction().map_err(StorageError::sqlite)?;
            let running: u64 = tx.query_row(RUNNING_WORKERS_SQL, [&parent], |r| r.get(0))
                .map_err(StorageError::sqlite)?;
            if running >= cap { return Ok(None); }
            let next: Option<String> = tx.query_row(WAITING_WORKERS_SQL, [&parent], |r| r.get(0))
                .optional().map_err(StorageError::sqlite)?;
            let Some(id) = next else { return Ok(None); };
            tx.execute("UPDATE btcc_subsession_delegations SET dispatch_state='enqueued' WHERE relation_id=?1", [&id])
                .map_err(StorageError::sqlite)?;
            let stored = read(&tx, "r.relation_id=?1", &id)?;
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(stored)
        }).await
    }

    /// Even after turn delivery, result closeout must settle before a new
    /// direction is published. Otherwise that closeout could retire its dispatch.
    pub(crate) async fn worker_turn_unsettled(
        &self,
        relation: String,
    ) -> Result<bool, StorageError> {
        self.storage.read(move |db| {
            db.query_row("SELECT EXISTS (SELECT 1 FROM btcc_session_relations r JOIN btcc_turns t ON t.session_id=r.child_session_id WHERE r.relation_id=?1 AND NOT EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=r.relation_id AND x.child_turn_id=t.turn_id))", [relation], |r| r.get(0)).map_err(StorageError::sqlite)
        }).await
    }

    /// A transient publication guard derived from immutable results, never stored.
    pub(crate) async fn worker_result_marker(
        &self,
        relation: String,
    ) -> Result<Option<String>, StorageError> {
        self.storage
            .read(move |db| {
                db.query_row(WORKER_RESULT_MARKER_SQL, [relation], |r| r.get(0))
                    .optional()
                    .map_err(StorageError::sqlite)
            })
            .await
    }

    pub(crate) async fn worker_publish_failed(
        &self,
        relation: String,
        previous_result: Option<String>,
    ) -> Result<(), StorageError> {
        self.storage
            .execute(move |db| {
                // A terminal result can admit a newer continuation while the old
                // publisher is in flight. Its failure must not undo that admission.
                db.execute(RETRY_WORKER_SQL, params![relation, previous_result])
                    .map_err(StorageError::sqlite)?;
                Ok(())
            })
            .await
    }

    /// Old databases can contain a pending direction after a cancelled result
    /// with an inactive dispatch. Restore that unfinished continuation only.
    pub(crate) async fn restore_waiting_direction(
        &self,
        relation: String,
    ) -> Result<(), StorageError> {
        self.storage.execute(move |db| {
            db.execute("UPDATE btcc_subsession_delegations SET dispatch_state='pending' WHERE relation_id=?1 AND dispatch_state IS NULL AND EXISTS (SELECT 1 FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending')", [relation]).map_err(StorageError::sqlite)?;
            Ok(())
        }).await
    }

    pub(crate) async fn enqueued_workers(
        &self,
    ) -> Result<Vec<StoredSubsessionDelegation>, StorageError> {
        self.storage.read(|db| {
            decode::list(db, "WHERE d.dispatch_state='enqueued' AND r.activity_role='worker' AND (NOT EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=d.relation_id) OR EXISTS (SELECT 1 FROM btcc_subsession_directions i WHERE i.relation_id=d.relation_id AND i.status='pending')) ORDER BY d.created_at,d.rowid", [])
        }).await
    }

    pub(crate) async fn worker_first_turn_ended(
        &self,
        relation: String,
    ) -> Result<bool, StorageError> {
        self.storage
            .read(move |db| {
                db.query_row(FIRST_ENDED, [relation], |r| r.get(0))
                    .map_err(StorageError::sqlite)
            })
            .await
    }
}
