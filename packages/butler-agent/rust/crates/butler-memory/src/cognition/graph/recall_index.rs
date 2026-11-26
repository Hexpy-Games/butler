//! Incremental alias postings used by semantic recall after graph apply.
//!
//! Postings are `(gram, alias_id)`; readers join `memory_aliases` for node,
//! source and surface. A graph not yet compacted keeps its legacy table and
//! triggers until its schema writer compacts it (schema/alias_postings.rs).

use rusqlite::{Connection, OptionalExtension, params};
use unicode_segmentation::UnicodeSegmentation;

use super::db_error;
use crate::cognition::CognitionResult;

/// The compact postings with the legacy column names readers select.
const COMPACT_POSTINGS: &str = "(SELECT ap.gram AS gram,aa.node_id AS node_id,aa.source_id AS source_id,aa.surface_original AS surface_original FROM memory_alias_postings ap JOIN memory_aliases aa ON aa.alias_id=ap.alias_id)";

const TRIGGERS: &str = r"CREATE TABLE IF NOT EXISTS memory_alias_index_dirty(node_id TEXT NOT NULL,source_id TEXT NOT NULL,surface_original TEXT NOT NULL,PRIMARY KEY(node_id,source_id,surface_original));
 CREATE TRIGGER IF NOT EXISTS memory_alias_index_insert AFTER INSERT ON memory_aliases BEGIN
   INSERT OR IGNORE INTO memory_alias_index_dirty VALUES(NEW.node_id,NEW.source_id,NEW.surface_original); END;
 CREATE TRIGGER IF NOT EXISTS memory_alias_index_update AFTER UPDATE ON memory_aliases BEGIN
   DELETE FROM memory_alias_postings WHERE alias_id=OLD.alias_id;
   INSERT OR IGNORE INTO memory_alias_index_dirty VALUES(NEW.node_id,NEW.source_id,NEW.surface_original); END;
 CREATE TRIGGER IF NOT EXISTS memory_alias_index_delete BEFORE DELETE ON memory_aliases BEGIN
   DELETE FROM memory_alias_postings WHERE alias_id=OLD.alias_id;
   DELETE FROM memory_alias_index_dirty WHERE node_id=OLD.node_id AND source_id=OLD.source_id AND surface_original=OLD.surface_original; END;
 CREATE TRIGGER IF NOT EXISTS memory_alias_index_scope AFTER UPDATE OF identity_scope,project_id ON memory_nodes
   WHEN NEW.identity_scope IS NOT OLD.identity_scope OR NEW.project_id IS NOT OLD.project_id BEGIN
   INSERT OR IGNORE INTO memory_alias_index_dirty SELECT node_id,source_id,surface_original FROM memory_aliases WHERE node_id=NEW.id; END;";

/// Whether this graph's postings are `(gram, alias_id)`.
pub(super) fn is_compact(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('memory_alias_postings') WHERE name='alias_id')",
        [],
        |row| row.get(0),
    )
}

/// `memory_alias_postings` as `(gram,node_id,source_id,surface_original)` in
/// either shape, for a reader's FROM clause.
pub(in crate::cognition) fn postings_relation(
    connection: &Connection,
) -> rusqlite::Result<&'static str> {
    Ok(if is_compact(connection)? {
        COMPACT_POSTINGS
    } else {
        "memory_alias_postings"
    })
}

/// One dirty alias and what its postings derive from.
struct Dirty {
    node: String,
    source: String,
    surface: String,
    alias: Option<i64>,
    folded: Option<String>,
    scope: Option<String>,
}

pub(super) fn install_and_backfill(connection: &Connection) -> CognitionResult<()> {
    // Compaction re-posts every alias, so a legacy graph defers until then.
    if !is_compact(connection).map_err(db_error)? {
        return Ok(());
    }
    connection.execute_batch(TRIGGERS).map_err(db_error)?;
    let ready = connection
        .query_row(
            "SELECT value FROM memory_state WHERE key='alias_postings_incremental_v1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?
        .is_some();
    if !ready {
        connection.execute("INSERT OR IGNORE INTO memory_alias_index_dirty SELECT node_id,source_id,surface_original FROM memory_aliases",[]).map_err(db_error)?;
    }
    let mut statement=connection.prepare("SELECT d.node_id,d.source_id,d.surface_original,a.alias_id,a.folded_key,n.identity_scope FROM memory_alias_index_dirty d LEFT JOIN memory_aliases a ON a.node_id=d.node_id AND a.source_id=d.source_id AND a.surface_original=d.surface_original LEFT JOIN memory_nodes n ON n.id=a.node_id").map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(Dirty {
                node: row.get(0)?,
                source: row.get(1)?,
                surface: row.get(2)?,
                alias: row.get(3)?,
                folded: row.get(4)?,
                scope: row.get(5)?,
            })
        })
        .map_err(db_error)?;
    for row in rows {
        reindex(connection, &row.map_err(db_error)?)?;
    }
    drop(statement);
    if !ready {
        connection.execute("INSERT INTO memory_state(key,value) VALUES('alias_postings_incremental_v1','complete')",[]).map_err(db_error)?;
    }
    Ok(())
}

/// Replaces one alias's postings with the distinct 2- and 3-grapheme windows
/// of its folded key; an alias without a node gets none.
fn reindex(connection: &Connection, dirty: &Dirty) -> CognitionResult<()> {
    if let Some(alias) = dirty.alias {
        connection
            .prepare_cached("DELETE FROM memory_alias_postings WHERE alias_id=?1")
            .and_then(|mut statement| statement.execute([alias]))
            .map_err(db_error)?;
        if let (Some(folded), Some(_)) = (&dirty.folded, &dirty.scope) {
            let graphemes =
                UnicodeSegmentation::graphemes(folded.as_str(), true).collect::<Vec<_>>();
            let mut insert = connection
                .prepare_cached(
                    "INSERT OR IGNORE INTO memory_alias_postings(gram,alias_id) VALUES(?1,?2)",
                )
                .map_err(db_error)?;
            for size in [2, 3] {
                for group in graphemes.windows(size) {
                    insert
                        .execute(params![group.concat(), alias])
                        .map_err(db_error)?;
                }
            }
        }
    }
    connection
        .prepare_cached("DELETE FROM memory_alias_index_dirty WHERE node_id=?1 AND source_id=?2 AND surface_original=?3")
        .and_then(|mut statement| statement.execute(params![dirty.node, dirty.source, dirty.surface]))
        .map_err(db_error)?;
    Ok(())
}
