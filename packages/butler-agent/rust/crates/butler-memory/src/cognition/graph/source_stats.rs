//! Corpus statistics of the source lexical index, kept current by triggers so a
//! raw recall reads them in constant time instead of scanning all source text.
use super::db_error;
use crate::cognition::CognitionResult;
use rusqlite::{Connection, OptionalExtension};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS memory_source_text_stats(id INTEGER PRIMARY KEY CHECK(id=1),documents INTEGER NOT NULL,total_length INTEGER NOT NULL);
INSERT OR REPLACE INTO memory_source_text_stats(id,documents,total_length) SELECT 1,COUNT(*),COALESCE(SUM(length(text)),0) FROM memory_source_text;
CREATE TRIGGER IF NOT EXISTS memory_source_text_stats_update AFTER UPDATE OF text ON memory_source_text BEGIN UPDATE memory_source_text_stats SET total_length=total_length-length(OLD.text)+length(NEW.text) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS memory_source_text_stats_delete AFTER DELETE ON memory_source_text BEGIN UPDATE memory_source_text_stats SET documents=documents-1,total_length=total_length-length(OLD.text) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS memory_source_text_stats_insert AFTER INSERT ON memory_source_text BEGIN UPDATE memory_source_text_stats SET documents=documents+1,total_length=total_length+length(NEW.text) WHERE id=1; END;
";

/// Whether the statistics and their triggers exist. The insert trigger is
/// created last, so its presence means the seed is complete.
pub(super) fn installed(db: &Connection) -> CognitionResult<bool> {
    db.query_row(
        "SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='memory_source_text_stats_insert'",
        [],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(db_error)
}

/// Seeds the statistics from the existing texts once, then keeps them by
/// trigger. Runs on the background consolidation path inside its transaction.
pub(super) fn install(db: &Connection) -> CognitionResult<()> {
    if installed(db)? {
        return Ok(());
    }
    db.execute_batch(SCHEMA).map_err(db_error)
}

/// Indexed source texts and their average length in characters; `None` until
/// the statistics are installed.
pub(super) fn read(db: &Connection) -> CognitionResult<Option<(i64, Option<f64>)>> {
    if !installed(db)? {
        return Ok(None);
    }
    db.query_row(
        "SELECT documents,CASE WHEN documents>0 THEN CAST(total_length AS REAL)/documents END FROM memory_source_text_stats WHERE id=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(db_error)
}
