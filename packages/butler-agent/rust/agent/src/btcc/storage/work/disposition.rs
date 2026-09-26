pub(super) mod evidence;
mod record;

use rusqlite::{Connection, OptionalExtension, params};

use crate::btcc::work::ClaimCloseoutCorrectionInput;

use super::{StorageError, StorageResult, common, relation};

use crate::btcc::StorageCode;
pub(super) use record::record;

pub(super) fn claim_correction(
    db: &Connection,
    input: &ClaimCloseoutCorrectionInput,
    clock: &dyn Fn() -> String,
) -> StorageResult<bool> {
    let work = relation::require_bound(db, &input.scope, true)?;
    if work.id != input.work_id {
        return Err(common::error(
            StorageCode::DurableWorkCloseoutNotBound,
            "Durable Work closeout diagnostic target is not bound to this Turn",
        ));
    }
    let key = crate::btcc::identity::digest(&format!(
        "btcc-guided-work-closeout-missing.v1\0{}\0{}",
        input.scope.turn_id, input.work_id
    ));
    let changed = db.execute("INSERT OR IGNORE INTO btcc_guided_work_closeout_diagnostics (diagnostic_id, diagnostic_key, code, turn_id, work_id, created_at) VALUES (?1, ?2, 'closeout_missing', ?3, ?4, ?5)", params![common::record_id("diagnostic", &key), key, input.scope.turn_id, input.work_id, clock()]).map_err(StorageError::sqlite)?;
    Ok(changed == 1)
}

fn replay(
    db: &Connection,
    call_id: &str,
    fingerprint: &str,
    work_id: &str,
) -> StorageResult<Option<String>> {
    let row = db.query_row("SELECT request_sha256, work_id, disposition_revision_id FROM btcc_guided_work_disposition_commands WHERE mutation_call_id = ?1", [call_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
        .optional().map_err(StorageError::sqlite)?;
    let Some((stored_hash, stored_work, _revision)) = row else {
        return Ok(None);
    };
    if stored_hash != fingerprint || stored_work != work_id {
        return Err(common::error(
            StorageCode::DurableWorkDispositionIdentityConflict,
            format!("Durable Work disposition identity conflict: {call_id}"),
        ));
    }
    Ok(Some(stored_work))
}
