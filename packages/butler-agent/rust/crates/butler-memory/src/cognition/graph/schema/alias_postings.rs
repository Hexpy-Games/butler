//! One-shot compaction of `memory_alias_postings` to `(gram, alias_id)`.
//!
//! The legacy table repeated each alias's node, source and surface in every
//! gram row and two secondary indexes. Compaction gives `memory_aliases` a
//! stable `alias_id` (VACUUM keeps INTEGER PRIMARY KEY values), rebuilds every
//! posting from `folded_key` with the incremental indexer, then reclaims the
//! freed pages once. An interrupted transaction rolls back and reruns; an
//! interrupted reclaim reruns from `reclaim_pending`.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

use super::super::{db_error, recall_index};
use crate::cognition::CognitionResult;

const KEY: &str = "alias_postings_compact_v1";

const INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_alias_postings_alias_id ON memory_alias_postings(alias_id);";

// The recall triggers are recreated by the indexer with alias_id bodies; the
// scope trigger on memory_nodes names memory_aliases and is recreated too.
const REBUILD: &str = r"DROP TRIGGER IF EXISTS memory_alias_index_scope;
DROP TABLE IF EXISTS memory_aliases_compact;
CREATE TABLE memory_aliases_compact(alias_id INTEGER PRIMARY KEY,node_id TEXT NOT NULL REFERENCES memory_nodes(id),surface_original TEXT NOT NULL,nfc_key TEXT NOT NULL,folded_key TEXT NOT NULL,language_tags TEXT NOT NULL DEFAULT '[]',source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),resolution_kind TEXT NOT NULL,UNIQUE(node_id,surface_original,source_id));
INSERT INTO memory_aliases_compact(node_id,surface_original,nfc_key,folded_key,language_tags,source_id,resolution_kind) SELECT node_id,surface_original,nfc_key,folded_key,language_tags,source_id,resolution_kind FROM memory_aliases ORDER BY rowid;
DROP TABLE memory_aliases;
ALTER TABLE memory_aliases_compact RENAME TO memory_aliases;
DROP TABLE memory_alias_postings;
CREATE TABLE memory_alias_postings(gram TEXT NOT NULL,alias_id INTEGER NOT NULL,PRIMARY KEY(gram,alias_id)) WITHOUT ROWID;
CREATE INDEX idx_alias_postings_alias_id ON memory_alias_postings(alias_id);";

/// Compacts once per graph; a pending reclaim is left to `recover`.
pub(super) fn ensure(connection: &mut Connection) -> CognitionResult<()> {
    if !connection.is_autocommit() {
        return Ok(());
    }
    let state: Option<String> = connection
        .query_row(
            "SELECT value FROM memory_state WHERE key=?1",
            [KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    match state.as_deref() {
        None if migrate(connection)? => {
            reclaim_or_defer(connection);
            Ok(())
        }
        // Complete, or a reclaim pending for `recover`.
        _ => Ok(()),
    }
}

/// Recovery-lease entry: compacts like `ensure` and retries a deferred reclaim.
pub(super) fn recover(connection: &mut Connection) -> CognitionResult<()> {
    let pending = connection.is_autocommit()
        && connection
            .query_row(
                "SELECT value FROM memory_state WHERE key=?1",
                [KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?
            .is_some_and(|value| value == "reclaim_pending");
    if pending {
        reclaim_or_defer(connection);
        return Ok(());
    }
    ensure(connection)
}

/// The rebuilt graph is already correct; a failed reclaim keeps
/// `reclaim_pending` for the next recovery pass instead of failing the caller.
fn reclaim_or_defer(connection: &Connection) {
    if let Err(error) = reclaim(connection) {
        tracing::warn!(%error, "alias postings reclaim deferred");
    }
}

/// Compacts a graph file no other connection has open (a reset's staged copy).
pub(in crate::cognition) fn compact_file(path: &Path) -> CognitionResult<()> {
    let mut connection = butler_platform::sqlite::open(path).map_err(db_error)?;
    ensure(&mut connection)?;
    connection.close().map_err(|(_, error)| db_error(error))
}

/// One transaction; `Ok(true)` when a legacy table was rebuilt and its pages
/// await reclaiming. A graph born compact only gains its index and key.
fn migrate(connection: &mut Connection) -> CognitionResult<bool> {
    connection
        .execute_batch("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON")
        .map_err(db_error)?;
    let migrated = (|| {
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let legacy = !recall_index::is_compact(&tx).map_err(db_error)?;
        if legacy {
            rebuild(&tx)?;
            tx.execute("INSERT INTO memory_state(key,value) VALUES(?1,'reclaim_pending') ON CONFLICT(key) DO UPDATE SET value=excluded.value", [KEY]).map_err(db_error)?;
        } else {
            tx.execute_batch(INDEX).map_err(db_error)?;
            tx.execute(
                "INSERT OR IGNORE INTO memory_state(key,value) VALUES(?1,'complete')",
                [KEY],
            )
            .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(legacy)
    })();
    let restore = connection
        .execute_batch("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON")
        .map_err(db_error);
    migrated.and_then(|legacy| restore.map(|()| legacy))
}

/// Indexes and triggers other owners keep on memory_aliases (episode FTS) are
/// dropped with the table; recreate them from their stored SQL.
fn rebuild(tx: &Connection) -> CognitionResult<()> {
    let mut statement = tx
        .prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='memory_aliases' AND type IN ('index','trigger') AND sql IS NOT NULL AND name NOT IN ('memory_alias_index_insert','memory_alias_index_update','memory_alias_index_delete')")
        .map_err(db_error)?;
    let dependents = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);
    tx.execute_batch(REBUILD).map_err(db_error)?;
    for sql in &dependents {
        tx.execute_batch(sql).map_err(db_error)?;
    }
    // Without its key the indexer marks every alias dirty and re-posts it.
    tx.execute(
        "DELETE FROM memory_state WHERE key='alias_postings_incremental_v1'",
        [],
    )
    .map_err(db_error)?;
    recall_index::install_and_backfill(tx)
}

/// Reclaims the legacy pages once. VACUUM in WAL mode leaves readers on their
/// snapshot; a checkpoint a reader blocks reports busy and is not an error.
/// The journal size limit lets later checkpoints shrink a WAL the VACUUM grew.
fn reclaim(connection: &Connection) -> CognitionResult<()> {
    connection
        .execute_batch("PRAGMA journal_size_limit=67108864")
        .map_err(db_error)?;
    connection.execute_batch("VACUUM").map_err(db_error)?;
    connection
        .execute(
            "UPDATE memory_state SET value='complete' WHERE key=?1",
            [KEY],
        )
        .map_err(db_error)?;
    connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .map_err(db_error)
}
