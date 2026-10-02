//! Byte-bounded alias/gram keyset copy. Cursor and data commit together.
use super::{Alias, aborted, db_error, schema};
use crate::cognition::{CognitionCode, CognitionError, CognitionResult};
use rusqlite::{Connection, OptionalExtension, params};
use tokio_util::sync::CancellationToken;

const BATCH_BYTES: usize = 64 * 1024;

pub(super) fn batch(db: &Connection, stop: &CancellationToken) -> CognitionResult<()> {
    let encoded: String = db
        .query_row(
            "SELECT value FROM memory_state WHERE key='alias_postings_v2_cursor'",
            [],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    let mut cursor: Alias = serde_json::from_str(&encoded).map_err(json_error)?;
    let mut bytes = 0;
    while bytes < BATCH_BYTES {
        if stop.is_cancelled() {
            return Err(aborted());
        }
        // Unready dictionaries resume a partially copied alias first.
        let pending: Option<String> = db
            .query_row(
                "SELECT value FROM memory_state WHERE key='alias_postings_v2_pending'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let pending: Option<Alias> = pending
            .map(|s| serde_json::from_str(&s).map_err(json_error))
            .transpose()?;
        let alias = match pending {
            Some(alias) => Some(alias),
            None => db.query_row("SELECT node_id,surface_original,source_id FROM memory_aliases WHERE (node_id,surface_original,source_id)>(?1,?2,?3) ORDER BY node_id,surface_original,source_id LIMIT 1", params![cursor.0,cursor.1,cursor.2], tuple).optional().map_err(db_error)?,
        };
        let Some(alias) = alias else {
            certify(db)?;
            db.execute_batch(schema::CUTOVER).map_err(db_error)?;
            return Ok(());
        };
        let exists: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM memory_aliases WHERE node_id=?1 AND surface_original=?2 AND source_id=?3)",params![alias.0,alias.1,alias.2],|r|r.get(0)).map_err(db_error)?;
        if !exists {
            db.execute("DELETE FROM memory_state WHERE key IN ('alias_postings_v2_pending','alias_postings_v2_pending_id')",[]).map_err(db_error)?;
            continue;
        }
        let cost = alias.0.len() + alias.1.len() + alias.2.len() + 128;
        if cost > BATCH_BYTES {
            return Err(CognitionError::new(
                CognitionCode::MemoryGraphUnavailable,
                "alias dictionary exceeds migration byte budget",
            ));
        }
        if bytes + cost > BATCH_BYTES {
            break;
        }
        bytes += cost;
        if !copy_alias(db, &alias, &mut bytes, stop)? {
            break;
        }
        cursor = alias;
        let encoded = serde_json::to_string(&cursor).map_err(json_error)?;
        db.execute(
            "UPDATE memory_state SET value=?1 WHERE key='alias_postings_v2_cursor'",
            [encoded],
        )
        .map_err(db_error)?;
    }
    Ok(())
}

fn copy_alias(
    db: &Connection,
    alias: &Alias,
    bytes: &mut usize,
    stop: &CancellationToken,
) -> CognitionResult<bool> {
    let (node, surface, source) = alias;
    db.execute("INSERT OR IGNORE INTO memory_alias_documents(node_id,source_id,surface_original) VALUES(?1,?2,?3)", params![node,source,surface]).map_err(db_error)?;
    let id: i64 = db.query_row("SELECT id FROM memory_alias_documents WHERE node_id=?1 AND source_id=?2 AND surface_original=?3", params![node,source,surface], |r|r.get(0)).map_err(db_error)?;
    let encoded = serde_json::to_string(alias).map_err(json_error)?;
    db.execute(
        "INSERT OR REPLACE INTO memory_state VALUES('alias_postings_v2_pending',?1)",
        [encoded],
    )
    .map_err(db_error)?;
    db.execute(
        "INSERT OR REPLACE INTO memory_state VALUES('alias_postings_v2_pending_id',?1)",
        [id.to_string()],
    )
    .map_err(db_error)?;
    let last: String = db
        .query_row(
            "SELECT COALESCE(MAX(gram),'') FROM memory_alias_grams WHERE alias_id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    let mut statement = db.prepare("SELECT gram FROM memory_alias_postings WHERE node_id=?1 AND source_id=?2 AND surface_original=?3 AND gram>?4 ORDER BY gram").map_err(db_error)?;
    let mut rows = statement
        .query(params![node, source, surface, last])
        .map_err(db_error)?;
    let mut insert = db
        .prepare_cached("INSERT INTO memory_alias_grams VALUES(?1,?2)")
        .map_err(db_error)?;
    while let Some(row) = rows.next().map_err(db_error)? {
        if stop.is_cancelled() {
            return Err(aborted());
        }
        let gram: String = row.get(0).map_err(db_error)?;
        let cost = gram.len() + 64;
        if cost > BATCH_BYTES {
            return Err(CognitionError::new(
                CognitionCode::MemoryGraphUnavailable,
                "alias gram exceeds migration byte budget",
            ));
        }
        if *bytes + cost > BATCH_BYTES {
            return Ok(false);
        }
        *bytes += cost;
        insert.execute(params![gram, id]).map_err(db_error)?;
        super::stop_probe::hold(db, stop)?;
    }
    db.execute("DELETE FROM memory_state WHERE key IN ('alias_postings_v2_pending','alias_postings_v2_pending_id')",[]).map_err(db_error)?;
    Ok(true)
}

fn certify(db: &Connection) -> CognitionResult<()> {
    let equal: bool = db.query_row("SELECT (SELECT COUNT(*) FROM memory_alias_documents)=(SELECT COUNT(*) FROM memory_aliases) AND NOT EXISTS(SELECT 1 FROM memory_state WHERE key='alias_postings_v2_pending') AND NOT EXISTS(SELECT 1 FROM memory_alias_index_dirty) AND (SELECT COUNT(*) FROM memory_alias_grams)=(SELECT COUNT(*) FROM memory_alias_postings)", [], |r| r.get(0)).map_err(db_error)?;
    if !equal {
        return Err(CognitionError::new(
            CognitionCode::MemoryGraphUnavailable,
            "alias dictionary/posting invariant failed",
        ));
    }
    Ok(())
}

fn tuple(r: &rusqlite::Row<'_>) -> rusqlite::Result<Alias> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
}
fn json_error(e: serde_json::Error) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryGraphUnavailable, e.to_string()).with_source(e)
}
