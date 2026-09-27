//! Rolling Context summaries on the existing serialized BTCC SQLite lane.

use std::sync::Arc;

use rusqlite::{Connection, params};

use super::{BtccStorage, StorageError, StorageResult};
use crate::btcc::{BtccError, StorageCode};

const LOAD: &str = "SELECT source_digest, covered_units, summary \
    FROM btcc_context_compactions WHERE turn_id=?1 ORDER BY covered_units DESC";
const SAVE: &str = "INSERT OR REPLACE INTO btcc_context_compactions \
    (turn_id, source_digest, covered_units, summary) VALUES (?1,?2,?3,?4)";

/// A stored summary of the first units of a turn's context.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextCompactionRecord {
    pub source_digest: String,
    pub covered_units: usize,
    pub summary: Arc<str>,
}

/// Stores context compactions per turn.
#[derive(Clone)]
pub struct ContextCompactionRepository {
    storage: BtccStorage,
}

impl ContextCompactionRepository {
    /// A repository over the store.
    pub fn new(storage: BtccStorage) -> Self {
        Self { storage }
    }

    /// The turn's compactions in order.
    pub async fn load(
        &self,
        turn_id: &str,
    ) -> Result<Arc<[Arc<ContextCompactionRecord>]>, BtccError> {
        let turn_id = turn_id.to_owned();
        self.storage
            .execute(move |connection| load(connection, &turn_id))
            .await
            .map(Arc::from)
            .map_err(BtccError::from)
    }

    /// Stores a compaction for the turn.
    pub async fn save(
        &self,
        turn_id: &str,
        record: &ContextCompactionRecord,
    ) -> Result<(), BtccError> {
        let turn_id = turn_id.to_owned();
        let record = record.clone();
        self.storage
            .execute(move |connection| save(connection, &turn_id, &record))
            .await
            .map_err(BtccError::from)
    }
}

fn load(
    connection: &Connection,
    turn_id: &str,
) -> StorageResult<Vec<Arc<ContextCompactionRecord>>> {
    let mut statement = connection.prepare(LOAD).map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map([turn_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(StorageError::sqlite)?;
    rows.map(|row| {
        let (source_digest, covered_units, summary) = row.map_err(StorageError::sqlite)?;
        let covered_units = usize::try_from(covered_units)
            .map_err(|source| invalid_record().with_source(source))?;
        Ok(Arc::new(ContextCompactionRecord {
            source_digest,
            covered_units,
            summary: summary.into(),
        }))
    })
    .collect()
}

fn save(
    connection: &Connection,
    turn_id: &str,
    record: &ContextCompactionRecord,
) -> StorageResult<()> {
    let covered_units = i64::try_from(record.covered_units)
        .map_err(|source| invalid_record().with_source(source))?;
    connection
        .execute(
            SAVE,
            params![
                turn_id,
                record.source_digest,
                covered_units,
                record.summary.as_ref()
            ],
        )
        .map(|_| ())
        .map_err(StorageError::sqlite)
}

fn invalid_record() -> StorageError {
    StorageError::new(
        StorageCode::ContextCompactionRecordInvalid,
        "BTCC context compaction has an invalid covered unit count",
    )
}

#[cfg(test)]
mod tests;
