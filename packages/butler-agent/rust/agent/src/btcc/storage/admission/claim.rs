use rusqlite::{Connection, OptionalExtension, params};

use crate::btcc::identity::digest;
use crate::btcc::storage::common::error;
use crate::btcc::storage::runtime_owner::RuntimeOwner;
use crate::btcc::storage::{StorageError, StorageResult};

use super::types::AdmissionClaim;

pub(super) fn acquire_claim(
    connection: &mut Connection,
    owner: &RuntimeOwner,
    inbox_id: &str,
) -> StorageResult<AdmissionClaim> {
    let claim_id = digest(&format!("btcc-admission-claim.v1\0{inbox_id}"));
    let transaction = connection.transaction().map_err(StorageError::sqlite)?;
    transaction.execute(
        "INSERT OR IGNORE INTO btcc_admission_claims (claim_id, inbox_id, owner_id, owner_generation, \
         lease_generation, status) VALUES (?1, ?2, ?3, ?4, 1, 'active')",
        params![claim_id, inbox_id, owner.owner_id(), owner.generation()],
    ).map_err(StorageError::sqlite)?;
    let current = claim_row(&transaction, &claim_id)?.ok_or_else(|| {
        error(
            "admission_claim_missing",
            "BTCC Admission claim was not persisted",
        )
    })?;
    if current.0 != owner.owner_id() || current.1 != owner.generation() {
        if current.3 != "relinquished" && !owner.can_adopt_claim_from(&transaction, &current.0)? {
            return Err(error(
                "admission_claim_live",
                "BTCC Admission is actively owned by another live runtime",
            ));
        }
        let changed = transaction.execute(
            "UPDATE btcc_admission_claims SET status = 'active', owner_id = ?1, owner_generation = ?2, \
             lease_generation = lease_generation + 1 WHERE claim_id = ?3 AND owner_id = ?4 \
             AND owner_generation = ?5 AND lease_generation = ?6 AND status = ?7",
            params![owner.owner_id(), owner.generation(), claim_id, current.0, current.1, current.2, current.3],
        ).map_err(StorageError::sqlite)?;
        if changed != 1 {
            return Err(error(
                "admission_claim_raced",
                "BTCC Admission claim adoption raced",
            ));
        }
    }
    let claimed = claim_row(&transaction, &claim_id)?.ok_or_else(|| {
        error(
            "admission_claim_missing",
            "BTCC Admission claim was not persisted",
        )
    })?;
    if claimed.0 != owner.owner_id() || claimed.1 != owner.generation() || claimed.3 != "active" {
        return Err(error(
            "admission_claim_inactive",
            "BTCC Admission is not actively owned by this runtime",
        ));
    }
    transaction.commit().map_err(StorageError::sqlite)?;
    Ok(AdmissionClaim { claim_id })
}

fn claim_row(
    connection: &Connection,
    claim_id: &str,
) -> StorageResult<Option<(String, u64, u64, String)>> {
    connection
        .query_row(
            "SELECT owner_id, owner_generation, lease_generation, status \
        FROM btcc_admission_claims WHERE claim_id = ?1",
            [claim_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)
}
