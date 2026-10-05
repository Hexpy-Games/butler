//! Optional upgrade of existing rows, bounded to 32 per completion-consumer step.
use super::super::db_error;
use crate::cognition::CognitionResult;
use rusqlite::{Connection, OptionalExtension};

pub(super) fn enqueue(db: &Connection) -> CognitionResult<bool> {
    let cursor = db
        .query_row(
            "SELECT value FROM memory_state WHERE key='episode_fts_script_cursor'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let Some(cursor) = cursor else {
        return Ok(false);
    };
    let ids = {
        let mut statement = db.prepare("SELECT episode_id FROM memory_episode_fts_meta WHERE episode_id>?1 AND episode_id<=(SELECT value FROM memory_state WHERE key='episode_fts_script_end') ORDER BY episode_id LIMIT 32").map_err(db_error)?;
        statement
            .query_map([cursor], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?
    };
    for id in &ids {
        db.execute(
            "INSERT OR IGNORE INTO memory_episode_fts_pending VALUES(?1)",
            [id],
        )
        .map_err(db_error)?;
    }
    if let Some(last) = ids.last() {
        db.execute(
            "UPDATE memory_state SET value=?1 WHERE key='episode_fts_script_cursor'",
            [last],
        )
        .map_err(db_error)?;
    } else {
        db.execute("DELETE FROM memory_state WHERE key IN ('episode_fts_script_cursor','episode_fts_script_end')", []).map_err(db_error)?;
    }
    Ok(true)
}

#[cfg(test)]
pub(in crate::cognition::graph) fn assert_resumable(db: &Connection) {
    db.execute_batch("DELETE FROM memory_state WHERE key IN ('episode_fts_script_cursor','episode_fts_script_end'); INSERT INTO memory_state VALUES('episode_fts_script_cursor',''),('episode_fts_script_end','upgrade-64');").unwrap();
    for n in 0..65 {
        db.execute("INSERT INTO memory_episode_fts_meta(episode_id,revision,source_refs_json,content_hash) VALUES(?1,'1','[]','hash')", [format!("upgrade-{n:02}")]).unwrap();
    }
    // Aborted work must roll back both the queue and the durable cursor.
    let tx = db.unchecked_transaction().unwrap();
    assert!(enqueue(&tx).unwrap());
    drop(tx);
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM memory_episode_fts_pending", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    for (expected, cursor) in [(32, "upgrade-31"), (64, "upgrade-63"), (65, "upgrade-64")] {
        let tx = db.unchecked_transaction().unwrap();
        assert!(enqueue(&tx).unwrap());
        tx.commit().unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM memory_episode_fts_pending", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            expected
        );
        assert_eq!(
            db.query_row(
                "SELECT value FROM memory_state WHERE key='episode_fts_script_cursor'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            cursor
        );
    }
    assert!(enqueue(db).unwrap());
    assert!(!enqueue(db).unwrap());
    db.execute_batch(
        "DELETE FROM memory_episode_fts_pending; DELETE FROM memory_episode_fts_meta;",
    )
    .unwrap();
}
