//! Cancellation settles the whole waiting continuation on the writer lane.
use super::*;

impl SqliteSubsessionRepository {
    pub(crate) async fn child_turn_exists(
        &self,
        session: String,
        turn: String,
    ) -> Result<bool, StorageError> {
        self.storage
            .read(move |db| {
                db.query_row(
                    "SELECT EXISTS (SELECT 1 FROM btcc_turns WHERE turn_id=?1 AND session_id=?2)",
                    params![turn, session],
                    |r| r.get(0),
                )
                .map_err(StorageError::sqlite)
            })
            .await
    }

    pub(crate) async fn worker_cancellable(&self, relation: String) -> Result<bool, StorageError> {
        self.storage.read(move |db| {
            let pending: bool = db.query_row("SELECT EXISTS (SELECT 1 FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending')", [&relation], |r| r.get(0))
                .map_err(StorageError::sqlite)?;
            let live: bool = db.query_row(worker_admission::WORKER_TURN_UNSETTLED_SQL, [&relation], |r| r.get(0))
                .map_err(StorageError::sqlite)?;
            Ok(pending || live)
        }).await
    }

    /// Returns the current or unpublished turn to stop. Recheck eligibility in
    /// the same transaction that retires directions and their dispatch state.
    pub(crate) async fn cancel_worker_pending(
        &self,
        relation: String,
        now: String,
    ) -> Result<Option<String>, StorageError> {
        self.storage.execute(move |db| {
            let tx = db.transaction().map_err(StorageError::sqlite)?;
            let Some(stored) = read(&tx, "r.relation_id=?1", &relation)? else { return Ok(None); };
            let live: Option<String> = tx.query_row(
                "SELECT t.turn_id FROM btcc_turns t WHERE t.session_id=?1 AND NOT EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=?2 AND x.child_turn_id=t.turn_id) ORDER BY t.rowid DESC LIMIT 1",
                params![stored.child_session_id,relation], |r| r.get(0),
            ).optional().map_err(StorageError::sqlite)?;
            let direction: Option<String> = tx.query_row(
                "SELECT instruction_id FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending' ORDER BY revision LIMIT 1", [&relation], |r| r.get(0),
            ).optional().map_err(StorageError::sqlite)?;
            let ended: bool = tx.query_row(worker_admission::FIRST_ENDED, [&relation], |r| r.get(0))
                .map_err(StorageError::sqlite)?;
            if ended && live.is_none() && direction.is_none() { return Ok(None); }
            let turn = live.unwrap_or_else(|| {
                if ended { direction.map(|id| direction_turn_id(&id)).unwrap_or(stored.child_turn_id.clone()) }
                else { stored.child_turn_id }
            });
            tx.execute("UPDATE btcc_subsession_directions SET status='applied',applied_at=?2,applied_child_turn_id=?3 WHERE relation_id=?1 AND status='pending'", params![relation,now,turn])
                .map_err(StorageError::sqlite)?;
            tx.execute("UPDATE btcc_subsession_delegations SET dispatch_state=NULL WHERE relation_id=?1", [&relation])
                .map_err(StorageError::sqlite)?;
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(Some(turn))
        }).await
    }
}
