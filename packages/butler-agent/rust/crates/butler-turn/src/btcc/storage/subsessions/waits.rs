//! Worker waits that nothing will end: the session's latest turn paused for
//! its children, yet none is outstanding and every child result already has
//! its own turn in the session.

use super::*;

/// The turn that brings one Worker result to its Steward.
pub(crate) fn worker_result_turn_id(result_id: &str) -> String {
    format!(
        "worker-result-turn-{}",
        crate::btcc::digest_identity(result_id)
    )
}

/// A paused turn whose wait no child result can end.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UnwokenWait {
    pub session_id: String,
    pub turn_id: String,
    pub original_message_id: String,
    pub original_message: String,
}

/// Latest turns of their sessions paused for a worker with no child left
/// unanswered. The partial index holds only paused turns; every other probe
/// is a keyed lookup.
const CANDIDATES: &str = "SELECT t.session_id,t.turn_id,t.original_message_id,t.original_message \
     FROM btcc_turns t INDEXED BY idx_btcc_turns_worker_waiting \
     WHERE t.semantic_state='admitted' AND t.suspension_reason='waiting_for_worker' \
     AND NOT EXISTS(SELECT 1 FROM btcc_turns n WHERE n.session_id=t.session_id AND n.rowid>t.rowid) \
     AND NOT EXISTS(SELECT 1 FROM btcc_session_relations r WHERE r.parent_session_id=t.session_id \
       AND NOT EXISTS(SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=r.relation_id))";

impl SqliteSubsessionRepository {
    /// Paused turns no delivered or queued child result will continue.
    pub(crate) async fn unwoken_worker_waits(&self) -> Result<Vec<UnwokenWait>, StorageError> {
        self.storage
            .execute(move |db| {
                let candidates = db
                    .prepare(CANDIDATES)
                    .map_err(StorageError::sqlite)?
                    .query_map([], |row| {
                        Ok(UnwokenWait {
                            session_id: row.get(0)?,
                            turn_id: row.get(1)?,
                            original_message_id: row.get(2)?,
                            original_message: row.get(3)?,
                        })
                    })
                    .map_err(StorageError::sqlite)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StorageError::sqlite)?;
                let mut unwoken = Vec::new();
                for wait in candidates {
                    if every_result_has_its_turn(db, &wait.session_id)? {
                        unwoken.push(wait);
                    }
                }
                Ok(unwoken)
            })
            .await
    }
}

/// A child result whose turn is not admitted yet is still queued (or about
/// to be) and continues the session itself.
fn every_result_has_its_turn(
    db: &rusqlite::Connection,
    session: &str,
) -> Result<bool, StorageError> {
    let results: Vec<String> = db
        .prepare_cached("SELECT result_id FROM btcc_subsession_outbox WHERE parent_session_id=?1")
        .map_err(StorageError::sqlite)?
        .query_map([session], |row| row.get(0))
        .map_err(StorageError::sqlite)?
        .collect::<Result<_, _>>()
        .map_err(StorageError::sqlite)?;
    let mut admitted = db
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE turn_id=?1)")
        .map_err(StorageError::sqlite)?;
    for result in results {
        let exists: bool = admitted
            .query_row([worker_result_turn_id(&result)], |row| row.get(0))
            .map_err(StorageError::sqlite)?;
        if !exists {
            return Ok(false);
        }
    }
    Ok(true)
}
