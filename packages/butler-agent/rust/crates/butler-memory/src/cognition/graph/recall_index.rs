//! Incremental alias postings used by semantic recall after graph apply.

use rusqlite::{Connection, OptionalExtension, params};
use unicode_segmentation::UnicodeSegmentation;

use super::db_error;
use crate::cognition::CognitionResult;

pub(super) fn install_and_backfill(connection: &Connection) -> CognitionResult<()> {
    connection.execute_batch(
        r"CREATE INDEX IF NOT EXISTS idx_alias_postings_gram_source ON memory_alias_postings(gram,node_id,source_id);
         CREATE INDEX IF NOT EXISTS idx_alias_postings_entity ON memory_alias_postings(node_id,gram,source_id,surface_original);
         CREATE INDEX IF NOT EXISTS idx_alias_postings_alias ON memory_alias_postings(node_id,source_id,surface_original,gram);
         CREATE INDEX IF NOT EXISTS idx_alias_postings_scope_gram_node ON memory_alias_postings(identity_scope,project_id,gram,node_id);
         CREATE TABLE IF NOT EXISTS memory_alias_index_dirty(node_id TEXT NOT NULL,source_id TEXT NOT NULL,surface_original TEXT NOT NULL,PRIMARY KEY(node_id,source_id,surface_original));
         CREATE TRIGGER IF NOT EXISTS memory_alias_index_insert AFTER INSERT ON memory_aliases BEGIN
           INSERT OR IGNORE INTO memory_alias_index_dirty VALUES(NEW.node_id,NEW.source_id,NEW.surface_original); END;
         CREATE TRIGGER IF NOT EXISTS memory_alias_index_update AFTER UPDATE ON memory_aliases BEGIN
           DELETE FROM memory_alias_postings WHERE node_id=OLD.node_id AND source_id=OLD.source_id AND surface_original=OLD.surface_original;
           INSERT OR IGNORE INTO memory_alias_index_dirty VALUES(NEW.node_id,NEW.source_id,NEW.surface_original); END;
         CREATE TRIGGER IF NOT EXISTS memory_alias_index_delete BEFORE DELETE ON memory_aliases BEGIN
           DELETE FROM memory_alias_postings WHERE node_id=OLD.node_id AND source_id=OLD.source_id AND surface_original=OLD.surface_original;
           DELETE FROM memory_alias_index_dirty WHERE node_id=OLD.node_id AND source_id=OLD.source_id AND surface_original=OLD.surface_original; END;
         CREATE TRIGGER IF NOT EXISTS memory_alias_index_scope AFTER UPDATE OF identity_scope,project_id ON memory_nodes
           WHEN NEW.identity_scope IS NOT OLD.identity_scope OR NEW.project_id IS NOT OLD.project_id BEGIN
           INSERT OR IGNORE INTO memory_alias_index_dirty SELECT node_id,source_id,surface_original FROM memory_aliases WHERE node_id=NEW.id; END;"
    ).map_err(db_error)?;
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
    let mut statement=connection.prepare("SELECT d.node_id,d.source_id,d.surface_original,a.folded_key,n.identity_scope,n.project_id FROM memory_alias_index_dirty d LEFT JOIN memory_aliases a ON a.node_id=d.node_id AND a.source_id=d.source_id AND a.surface_original=d.surface_original LEFT JOIN memory_nodes n ON n.id=a.node_id").map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(db_error)?;
    for row in rows {
        let (node, source, surface, folded, scope, project) = row.map_err(db_error)?;
        connection.execute("DELETE FROM memory_alias_postings WHERE node_id=?1 AND source_id=?2 AND surface_original=?3",params![node,source,surface]).map_err(db_error)?;
        if let (Some(folded), Some(scope)) = (folded, scope) {
            let graphemes =
                UnicodeSegmentation::graphemes(folded.as_str(), true).collect::<Vec<_>>();
            for size in [2, 3] {
                for group in graphemes.windows(size) {
                    connection.execute("INSERT OR IGNORE INTO memory_alias_postings(gram,node_id,source_id,surface_original,identity_scope,project_id) VALUES(?1,?2,?3,?4,?5,?6)",params![group.concat(),node,source,surface,scope,project]).map_err(db_error)?;
                }
            }
        }
        connection.execute("DELETE FROM memory_alias_index_dirty WHERE node_id=?1 AND source_id=?2 AND surface_original=?3",params![node,source,surface]).map_err(db_error)?;
    }
    drop(statement);
    if !ready {
        connection.execute("INSERT INTO memory_state(key,value) VALUES('alias_postings_incremental_v1','complete')",[]).map_err(db_error)?;
    }
    Ok(())
}
