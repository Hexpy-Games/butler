use crate::btcc::storage::StorageError;
use rusqlite::OptionalExtension;

/// A Worker result that is committed but whose Steward result turn has not started.
pub(super) fn has_unreceived_worker_result(
    db: &rusqlite::Connection,
    parent: &str,
) -> Result<bool, StorageError> {
    let mut statement = db
        .prepare_cached(
            "SELECT o.result_id FROM btcc_subsession_outbox o
             JOIN btcc_session_relations r ON r.relation_id=o.relation_id
             JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id
             WHERE r.parent_session_id=?1 AND json_extract(o.input_json,'$.route')='steward_queue'
               AND json_extract(d.packet_json,'$.superseded_by') IS NULL",
        )
        .map_err(StorageError::sqlite)?;
    let results = statement
        .query_map([parent], |row| row.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    for result in results {
        let turn = format!(
            "worker-result-turn-{}",
            crate::btcc::digest_identity(&result)
        );
        let started = db
            .query_row("SELECT 1 FROM btcc_turns WHERE turn_id=?1", [&turn], |_| {
                Ok(())
            })
            .optional()
            .map_err(StorageError::sqlite)?
            .is_some();
        if !started {
            return Ok(true);
        }
    }
    Ok(false)
}
