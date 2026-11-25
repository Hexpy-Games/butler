//! Opening graph.sqlite: read-write (IMMEDIATE, WAL), read-only and snapshot.
use butler_platform::sqlite;
use rusqlite::OpenFlags;
use std::{path::Path, time::Duration};

use super::{GraphRepository, db_error};
use crate::cognition::{CognitionResult, generation::pins};

/// How long a graph connection waits on a competing SQLite lock.
pub const GRAPH_BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);

impl GraphRepository {
    pub(in crate::cognition) fn open(path: &Path) -> CognitionResult<Self> {
        let mut connection = sqlite::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(db_error)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(db_error)?;
        connection
            .busy_timeout(GRAPH_BUSY_TIMEOUT)
            .map_err(db_error)?;
        connection.set_transaction_behavior(rusqlite::TransactionBehavior::Immediate);
        // A read transaction can block the switch. Fail immediately and retry on
        // the next open instead of stalling each open for five seconds.
        connection.busy_timeout(Duration::ZERO).map_err(db_error)?;
        match connection
            .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))
        {
            Ok(mode) if mode.eq_ignore_ascii_case("wal") => {}
            Ok(mode) => {
                butler_core::diagnostic!("[memory-graph-wal] journal_mode switch deferred: {mode}");
            }
            Err(error) => {
                butler_core::diagnostic!(
                    "[memory-graph-wal] journal_mode switch deferred: {error}"
                );
            }
        }
        connection
            .busy_timeout(GRAPH_BUSY_TIMEOUT)
            .map_err(db_error)?;
        Ok(Self {
            connection: Some(connection),
            _reader_pin: path.parent().map(pins::pin),
        })
    }

    pub(in crate::cognition) fn open_readonly(path: &Path) -> CognitionResult<Self> {
        let connection =
            sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(db_error)?;
        connection
            .busy_timeout(GRAPH_BUSY_TIMEOUT)
            .map_err(db_error)?;
        Ok(Self {
            connection: Some(connection),
            _reader_pin: path.parent().map(pins::pin),
        })
    }

    /// A fresh, consistent view for multi-query readers while writers advance.
    pub(in crate::cognition) fn open_read_snapshot(path: &Path) -> CognitionResult<Self> {
        let graph = Self::open_readonly(path)?;
        graph
            .connection()?
            .execute_batch("BEGIN")
            .map_err(db_error)?;
        Ok(graph)
    }
}
