//! Foreground compact writes consume the existing coalesced dirty queue.
use super::super::db_error;
use crate::cognition::CognitionResult;
use rusqlite::{Connection, params};

pub(in crate::cognition::graph) fn backfill(db: &Connection) -> CognitionResult<()> {
    let legacy: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='memory_alias_postings' AND type='table') AND (SELECT value FROM memory_state WHERE key='alias_postings_v2')!='reclaim'", [], |r| r.get(0)).map_err(db_error)?;
    let mut statement = db.prepare("SELECT d.node_id,d.source_id,d.surface_original,a.folded_key FROM memory_alias_index_dirty d LEFT JOIN memory_aliases a ON a.node_id=d.node_id AND a.source_id=d.source_id AND a.surface_original=d.surface_original").map_err(db_error)?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(db_error)?;
    for row in rows {
        let (node, source, surface, folded) = row.map_err(db_error)?;
        db.execute("DELETE FROM memory_alias_grams WHERE alias_id IN(SELECT id FROM memory_alias_documents WHERE node_id=?1 AND source_id=?2 AND surface_original=?3)",params![node,source,surface]).map_err(db_error)?;
        if let Some(folded) = folded {
            db.execute("INSERT OR IGNORE INTO memory_alias_documents(node_id,source_id,surface_original) VALUES(?1,?2,?3)",params![node,source,surface]).map_err(db_error)?;
            let id: i64 = db.query_row("SELECT id FROM memory_alias_documents WHERE node_id=?1 AND source_id=?2 AND surface_original=?3",params![node,source,surface],|r|r.get(0)).map_err(db_error)?;
            let mut insert = db
                .prepare_cached("INSERT OR IGNORE INTO memory_alias_grams VALUES(?1,?2)")
                .map_err(db_error)?;
            for gram in super::super::recall_index::grams(&folded) {
                insert.execute(params![gram, id]).map_err(db_error)?;
            }
        } else {
            db.execute("DELETE FROM memory_alias_documents WHERE node_id=?1 AND source_id=?2 AND surface_original=?3",params![node,source,surface]).map_err(db_error)?;
        }
        if !legacy {
            db.execute("DELETE FROM memory_alias_index_dirty WHERE node_id=?1 AND source_id=?2 AND surface_original=?3",params![node,source,surface]).map_err(db_error)?;
        }
    }
    Ok(())
}
