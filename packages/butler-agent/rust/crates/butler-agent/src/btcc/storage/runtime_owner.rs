use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, params};

use super::{StorageError, StorageResult};
use crate::btcc::StorageCode;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeOwnerIdentity {
    pub(crate) owner_id: String,
    pub(crate) host_id: String,
    pub(crate) process_id: u32,
    pub(crate) process_started_at_ms: u64,
}

pub(crate) trait ProcessLiveness: Send + Sync + 'static {
    fn is_alive(&self, identity: &RuntimeOwnerIdentity) -> bool;
}

#[cfg(test)]
pub(crate) struct ConservativeProcessLiveness;

#[cfg(test)]
impl ProcessLiveness for ConservativeProcessLiveness {
    fn is_alive(&self, _identity: &RuntimeOwnerIdentity) -> bool {
        true
    }
}

#[derive(Clone)]
pub(super) struct RuntimeOwner {
    identity: RuntimeOwnerIdentity,
    generation: u64,
    liveness: Arc<dyn ProcessLiveness>,
}

impl RuntimeOwner {
    pub(super) fn register(
        connection: &mut Connection,
        identity: RuntimeOwnerIdentity,
        liveness: Arc<dyn ProcessLiveness>,
    ) -> StorageResult<Self> {
        let transaction = connection.transaction().map_err(StorageError::sqlite)?;
        let existing = find(&transaction, &identity.owner_id)?;
        let generation = match existing {
            None => {
                transaction
                    .execute(
                        "INSERT INTO btcc_runtime_owners (owner_id, host_id, process_id, \
                         process_started_at_ms, owner_generation, status, registered_at) \
                         VALUES (?1, ?2, ?3, ?4, 1, 'active', \
                         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                        params![
                            identity.owner_id,
                            identity.host_id,
                            identity.process_id,
                            identity.process_started_at_ms,
                        ],
                    )
                    .map_err(StorageError::sqlite)?;
                1
            }
            Some(row) if row.status == "active" && row.same_process(&identity) => row.generation,
            Some(row) if row.status == "active" && liveness.is_alive(&row.identity()) => {
                return Err(StorageError::new(
                    StorageCode::RuntimeOwnerActive,
                    format!(
                        "BTCC runtime owner is already active: {}",
                        identity.owner_id
                    ),
                ));
            }
            Some(row) => {
                let generation = row.generation.checked_add(1).ok_or_else(|| {
                    StorageError::new(
                        StorageCode::RuntimeOwnerGenerationOverflow,
                        identity.owner_id.clone(),
                    )
                })?;
                let changed = transaction
                    .execute(
                        "UPDATE btcc_runtime_owners SET host_id = ?1, process_id = ?2, \
                         process_started_at_ms = ?3, owner_generation = ?4, status = 'active', \
                         registered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), closed_at = NULL \
                         WHERE owner_id = ?5 AND owner_generation = ?6",
                        params![
                            identity.host_id,
                            identity.process_id,
                            identity.process_started_at_ms,
                            generation,
                            identity.owner_id,
                            row.generation,
                        ],
                    )
                    .map_err(StorageError::sqlite)?;
                if changed != 1 {
                    return Err(StorageError::new(
                        StorageCode::RuntimeOwnerRegistrationRaced,
                        identity.owner_id.clone(),
                    ));
                }
                generation
            }
        };
        transaction.commit().map_err(StorageError::sqlite)?;
        Ok(Self {
            identity,
            generation,
            liveness,
        })
    }

    pub(super) fn owner_id(&self) -> &str {
        &self.identity.owner_id
    }

    pub(super) fn generation(&self) -> u64 {
        self.generation
    }

    pub(super) fn can_adopt_claim_from(
        &self,
        connection: &Connection,
        owner_id: &str,
    ) -> StorageResult<bool> {
        if owner_id == self.owner_id() {
            return Ok(true);
        }
        let row = find(connection, owner_id)?.ok_or_else(|| {
            StorageError::new(
                StorageCode::RuntimeOwnerRegistrationMissing,
                format!("BTCC claim owner has no durable runtime registration: {owner_id}"),
            )
        })?;
        if row.status != "active" {
            return Ok(true);
        }
        if self.liveness.is_alive(&row.identity()) {
            return Ok(false);
        }
        let changed = connection
            .execute(
                "UPDATE btcc_runtime_owners SET status = 'terminated', \
                 closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE owner_id = ?1 AND owner_generation = ?2 AND status = 'active'",
                params![row.owner_id, row.generation],
            )
            .map_err(StorageError::sqlite)?;
        if changed == 1 {
            return Ok(true);
        }
        Ok(find(connection, owner_id)?.is_some_and(|current| current.status != "active"))
    }

    pub(super) fn close(&self, connection: &Connection) -> StorageResult<()> {
        connection
            .execute(
                "UPDATE btcc_runtime_owners SET status = 'closed', \
                 closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE owner_id = ?1 AND owner_generation = ?2 AND status = 'active'",
                params![self.owner_id(), self.generation],
            )
            .map_err(StorageError::sqlite)?;
        Ok(())
    }
}

struct OwnerRow {
    owner_id: String,
    host_id: String,
    process_id: u32,
    process_started_at_ms: u64,
    generation: u64,
    status: String,
}

impl OwnerRow {
    fn identity(&self) -> RuntimeOwnerIdentity {
        RuntimeOwnerIdentity {
            owner_id: self.owner_id.clone(),
            host_id: self.host_id.clone(),
            process_id: self.process_id,
            process_started_at_ms: self.process_started_at_ms,
        }
    }

    fn same_process(&self, identity: &RuntimeOwnerIdentity) -> bool {
        self.host_id == identity.host_id
            && self.process_id == identity.process_id
            && self.process_started_at_ms == identity.process_started_at_ms
    }
}

fn find(connection: &Connection, owner_id: &str) -> StorageResult<Option<OwnerRow>> {
    connection
        .query_row(
            "SELECT owner_id, host_id, process_id, process_started_at_ms, \
             owner_generation, status FROM btcc_runtime_owners WHERE owner_id = ?1",
            [owner_id],
            |row| {
                Ok(OwnerRow {
                    owner_id: row.get(0)?,
                    host_id: row.get(1)?,
                    process_id: row.get(2)?,
                    process_started_at_ms: row.get(3)?,
                    generation: row.get(4)?,
                    status: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(StorageError::sqlite)
}
