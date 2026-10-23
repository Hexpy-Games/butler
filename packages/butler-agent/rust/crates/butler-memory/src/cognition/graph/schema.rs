//! The graph schema and its migrations.

mod base;
mod migration;
mod source_hash;

use rusqlite::{Connection, OptionalExtension};

use super::db_error;
use crate::cognition::CognitionCode;
use crate::cognition::{CognitionError, CognitionResult};

pub(super) fn ensure(connection: &mut Connection, now: &str) -> CognitionResult<()> {
    let legacy = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='entities'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(db_error)?
        .is_some();
    if legacy {
        return Err(CognitionError::new(
            CognitionCode::MemorySchemaMigrationRequired,
            "memory_schema_migration_required",
        ));
    }
    migration::nullable_source_ids(connection)?;
    base::create(connection)?;
    base::ensure_historical_columns(connection)?;
    migration::legacy_failures(connection, now)?;
    migration::interrupted_failures(connection, now)?;
    source_hash::complete_if_empty(connection, now)
}

/// The recovery lease also upgrades already-indexed serving graphs.
pub(super) fn recover_interrupted_failures(
    connection: &mut Connection,
    now: &str,
) -> CognitionResult<()> {
    migration::interrupted_failures(connection, now)
}

pub(super) fn ensure_column(
    connection: &Connection,
    table: &str,
    name: &str,
    declaration: &str,
) -> CognitionResult<()> {
    let sql = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&sql).map_err(db_error)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>("name"))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    if !names.iter().any(|value| value == name) {
        connection
            .execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {name} {declaration}"
            ))
            .map_err(db_error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
