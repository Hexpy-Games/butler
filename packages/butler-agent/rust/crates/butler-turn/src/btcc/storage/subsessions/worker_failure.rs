//! Terminal publication failures retire only the dispatch that failed.
use super::*;

impl SqliteSubsessionRepository {
    pub(crate) async fn fail_worker_publish(
        &self,
        relation: String,
        previous_result: Option<String>,
        code: String,
    ) -> Result<(), StorageError> {
        self.storage.execute(move |db| {
            let tx = db.transaction().map_err(StorageError::sqlite)?;
            let current: Option<String> = tx.query_row(
                worker_admission::WORKER_RESULT_MARKER_SQL, [&relation], |r| r.get(0),
            ).optional().map_err(StorageError::sqlite)?;
            // A late publisher must never fail a newer continuation.
            if current != previous_result { return Ok(()); }
            let stored = read(&tx, "r.relation_id=?1", &relation)?
                .ok_or_else(|| StorageError::new(StorageCode::SubsessionRelationMissing, "Subsession relation is missing"))?;
            if stored.dispatch_state == SubsessionDispatchState::Inactive { return Ok(()); }
            let direction: Option<String> = tx.query_row(
                "SELECT instruction_id FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending' ORDER BY revision LIMIT 1",
                [&relation], |r| r.get(0),
            ).optional().map_err(StorageError::sqlite)?;
            let turn = if current.is_some() {
                let Some(direction) = direction else { return Ok(()); };
                directions::direction_turn_id(&direction)
            } else {
                stored.child_turn_id
            };
            tx.execute(
                "INSERT INTO btcc_steward_results (result_id,relation_id,task_id,child_session_id,child_turn_id,status,code,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES (?1,?2,?3,?4,?5,'failed','delegation_context_incomplete',?6,'[]','[]',strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(result_id) DO NOTHING",
                params![completion::turn_result_id(&stored.child_session_id, &turn),relation,stored.task_id,stored.child_session_id,turn,format!("The Worker could not be dispatched: {code}.")],
            ).map_err(StorageError::sqlite)?;
            tx.execute("UPDATE btcc_subsession_delegations SET dispatch_state=NULL WHERE relation_id=?1", [&relation])
                .map_err(StorageError::sqlite)?;
            tx.execute("UPDATE btcc_subsession_directions SET status='applied',applied_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE relation_id=?1 AND status='pending'", [&relation])
                .map_err(StorageError::sqlite)?;
            tx.commit().map_err(StorageError::sqlite)
        }).await
    }
}
