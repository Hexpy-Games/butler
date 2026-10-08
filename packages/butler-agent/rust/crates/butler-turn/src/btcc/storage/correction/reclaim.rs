//! Queue-based reclamation; never select payload-state columns across history.
use super::*;
use butler_platform::secure_fs::abort_point;
use rusqlite::TransactionBehavior;

pub(super) fn backfill(db: &mut rusqlite::Connection) -> StorageResult<()> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StorageError::sqlite)?;
    tx.execute_batch(
        "INSERT OR IGNORE INTO agent_acceptance_reclaims(turn_id,enqueued_at)
      SELECT DISTINCT a.turn_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM btcc_model_round_acceptances a JOIN btcc_turns t ON t.turn_id=a.turn_id
      WHERE t.semantic_state <> 'admitted';
      INSERT INTO agent_storage_corrections(name,state,updated_at)
      VALUES('acceptance_payload_v1','reclaiming',strftime('%Y-%m-%dT%H:%M:%fZ','now'));",
    )
    .map_err(StorageError::sqlite)?;
    tx.commit().map_err(StorageError::sqlite)
}

pub(super) fn drain(db: &mut rusqlite::Connection, run: &mut Run<'_>) -> StorageResult<bool> {
    let end = (Instant::now() + Duration::from_secs(60)).min(run.deadline);
    db.pragma_update(None, "wal_autocheckpoint", 0)
        .map_err(StorageError::sqlite)?;
    loop {
        if run.stop.is_cancelled() || Instant::now() >= end {
            return Ok(false);
        }
        let started = Instant::now();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StorageError::sqlite)?;
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS chunk(turn_id TEXT PRIMARY KEY); DELETE FROM chunk;
          INSERT INTO chunk SELECT turn_id FROM agent_acceptance_reclaims LIMIT 64;
          UPDATE btcc_model_round_acceptances SET normalized_response_json='{}',continuation_delta_json=NULL,payload_state=2
          WHERE turn_id IN (SELECT c.turn_id FROM chunk c JOIN btcc_turns t ON t.turn_id=c.turn_id WHERE t.semantic_state <> 'admitted');") .map_err(StorageError::sqlite)?;
        let count = tx.execute("DELETE FROM agent_acceptance_reclaims WHERE turn_id IN (SELECT turn_id FROM chunk)",[]).map_err(StorageError::sqlite)?;
        if count == 0 {
            return Ok(true);
        }
        abort_point("reclaim_chunk");
        tx.commit().map_err(StorageError::sqlite)?;
        // No other connection exists. Reset after each chunk, bounding WAL and
        // reporting the actual frame bytes, including migration/backfill writes.
        let frames: u64 = db
            .query_row("PRAGMA wal_checkpoint(RESTART)", [], |r| r.get(1))
            .map_err(StorageError::sqlite)?;
        let page: u64 = db
            .pragma_query_value(None, "page_size", |r| r.get(0))
            .map_err(StorageError::sqlite)?;
        (run.progress)(
            &format!("reclaim_chunk turns={count}"),
            started.elapsed(),
            32 + frames * (page + 24),
        );
    }
}
