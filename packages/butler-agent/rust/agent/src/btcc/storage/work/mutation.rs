mod checkpoint;
mod plan;
mod progress;

use rusqlite::{Connection, OptionalExtension, params};

use super::{StorageError, StorageResult, common};

use crate::btcc::StorageCode;
pub(super) use checkpoint::record_checkpoint;
pub(super) use plan::replace_plan;
pub(super) use progress::{ProgressInput, assert_progress_revision, insert_progress};

pub(super) fn replay(
    db: &Connection,
    call_id: &str,
    operation: &str,
    fingerprint: &str,
) -> StorageResult<Option<String>> {
    let row = db.query_row("SELECT operation, request_sha256, work_id FROM btcc_guided_work_mutations WHERE mutation_call_id = ?1", [call_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).optional().map_err(StorageError::sqlite)?;
    let Some((stored_operation, stored_hash, work_id)) = row else {
        return Ok(None);
    };
    if stored_operation != operation || stored_hash != fingerprint {
        return Err(common::error(
            StorageCode::DurableWorkMutationIdentityConflict,
            format!("Durable Work mutation identity conflict: {call_id}"),
        ));
    }
    Ok(Some(work_id))
}

pub(super) fn record(
    db: &Connection,
    call_id: &str,
    operation: &str,
    fingerprint: &str,
    work_id: &str,
    record_id: &str,
    clock: &dyn Fn() -> String,
) -> StorageResult<()> {
    db.execute("INSERT INTO btcc_guided_work_mutations (mutation_call_id, operation, request_sha256, work_id, record_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![call_id, operation, fingerprint, work_id, record_id, clock()]).map_err(StorageError::sqlite)?;
    Ok(())
}
