//! Per-parent Worker admission on the SQLite writer lane.
use super::*;
use crate::btcc::{BtccError, SubsessionChildQueue, SubsessionEnqueue};
use std::sync::Arc;

pub(super) const FIRST_ENDED: &str = "SELECT EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.child_turn_id=d.child_turn_id AND x.relation_id=d.relation_id AND x.status<>'cancelled') FROM btcc_subsession_delegations d WHERE d.relation_id=?1 AND d.dispatch_state='enqueued'";

const PENDING: &str = "SELECT relation_id FROM btcc_subsession_delegations WHERE parent_session_id=?1 AND child_role='worker' AND dispatch_state='pending' ORDER BY created_at,rowid LIMIT 1";
const RUNNING: &str = "SELECT count(*) FROM btcc_subsession_delegations WHERE parent_session_id=?1 AND child_role='worker' AND dispatch_state='enqueued'";

impl SqliteSubsessionRepository {
    /// Admit the oldest pending Worker if this parent has a free slot. The
    /// queue is idempotent by event id. Enqueue before marking the row so a
    /// crash between the two is replayable; both run off Tokio on this lane.
    pub(crate) async fn dispatch_worker(
        &self,
        parent: String,
        expected: String,
        cap: u64,
        queue: Arc<dyn SubsessionChildQueue>,
    ) -> Result<bool, BtccError> {
        self.storage.execute(move |db| {
            let running: u64 = db.query_row(RUNNING, [&parent], |r| r.get(0))
                .map_err(StorageError::sqlite)?;
            if running >= cap { return Ok(Ok(false)); }
            let next: Option<String> = db.query_row(PENDING, [&parent], |r| r.get(0))
                .optional().map_err(StorageError::sqlite)?;
            let Some(id) = next else { return Ok(Ok(false)); };
            if id != expected { return Ok(Ok(true)); }
            let stored = read(db, "r.relation_id=?1", &id)?
                .ok_or_else(|| StorageError::new(StorageCode::SubsessionRelationMissing, "Worker relation missing"))?;
            let Some(intent) = stored.dispatch_intent else {
                return Ok(Err(BtccError::detected(crate::btcc::BtccCode::SubsessionDispatchIntentInvalid, "Worker dispatch intent missing")));
            };
            let envelope = serde_json::to_value(intent.envelope).map_err(|e|
                StorageError::new(StorageCode::SubsessionPacketInvalid, e.to_string()).with_source(e))?;
            if let Err(error) = queue.enqueue(SubsessionEnqueue { envelope, metadata: Default::default() }) {
                return Ok(Err(error));
            }
            db.execute("UPDATE btcc_subsession_delegations SET dispatch_state='enqueued' WHERE relation_id=?1", [&id])
                .map_err(StorageError::sqlite)?;
            Ok(Ok(true))
        }).await.map_err(BtccError::from)?
    }

    pub(crate) async fn pending_worker(
        &self,
        parent: String,
    ) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .read(move |db| {
                let id: Option<String> = db
                    .query_row(PENDING, [parent], |r| r.get(0))
                    .optional()
                    .map_err(StorageError::sqlite)?;
                id.map(|id| read(db, "r.relation_id=?1", &id))
                    .transpose()
                    .map(Option::flatten)
            })
            .await
    }

    /// A waiting Worker's direction cannot create its first execution turn.
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
