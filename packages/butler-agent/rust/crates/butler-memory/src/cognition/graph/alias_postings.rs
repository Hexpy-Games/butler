//! Bounded online copy. Legacy postings remain authoritative until certified.
mod copy;
mod reclaim;
mod schema;
mod stop_probe;
mod writes;

use rusqlite::{Connection, OptionalExtension};
use tokio_util::sync::CancellationToken;

use super::{GraphRepository, db_error};
use crate::cognition::{CognitionCode, CognitionError, CognitionResult};

type Alias = (String, String, String);

pub(in crate::cognition::graph) fn complete(db: &Connection) -> CognitionResult<bool> {
    Ok(matches!(
        state(db)?.as_deref(),
        Some("complete" | "fresh" | "reclaim")
    ))
}

fn state(db: &Connection) -> CognitionResult<Option<String>> {
    db.query_row(
        "SELECT value FROM memory_state WHERE key='alias_postings_v2'",
        [],
        |r| r.get(0),
    )
    .optional()
    .map_err(db_error)
}

/// Only rewrite storage names; callers keep every eligibility/ranking predicate.
pub(in crate::cognition::graph) fn query(db: &Connection, sql: &str) -> CognitionResult<String> {
    if std::env::var("BUTLER_ALIAS_POSTINGS_READ_V1").as_deref() == Ok("1") {
        let legacy: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='memory_alias_postings' AND type='table')", [], |r| r.get(0)).map_err(db_error)?;
        if legacy {
            return Ok(sql.to_owned());
        }
    }
    let installed = db
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE name='memory_alias_read_postings' AND type='view'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(db_error)?
        .is_some();
    let compact: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='memory_alias_grams') AND NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='memory_alias_postings' AND type='table')", [], |r| r.get(0)).map_err(db_error)?;
    let flipped = installed && complete(db)?;
    if (compact || flipped) && sql.contains("WITH eligible AS MATERIALIZED") {
        return Ok(sql.replace("SELECT DISTINCT a.node_id,a.source_id FROM memory_aliases a", "SELECT DISTINCT ad.id FROM memory_aliases a JOIN memory_alias_documents ad ON ad.node_id=a.node_id AND ad.source_id=a.source_id AND ad.surface_original=a.surface_original")
            .replace("FROM memory_alias_postings p", "FROM memory_alias_grams p")
            .replace("d.node_id=p.node_id AND d.source_id=p.source_id", "d.id=p.alias_id"));
    }
    if installed && sql.contains("WITH eligible AS MATERIALIZED") {
        // V1 remains fully maintained until reclaim. Its covering gram index
        // supplies complete frequencies without partitioning posting identities.
        return Ok(sql.to_owned());
    }
    Ok(if installed {
        sql.replace("memory_alias_postings", "memory_alias_read_postings")
    } else {
        sql.to_owned()
    })
}

impl GraphRepository {
    pub(in crate::cognition) fn open_alias_copy(path: &std::path::Path) -> CognitionResult<Self> {
        let graph = Self::open(path)?;
        graph
            .connection()?
            .set_db_config(
                rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
                true,
            )
            .map_err(db_error)?;
        Ok(graph)
    }

    /// One interruptible transaction, called only on the blocking leased stage.
    pub(in crate::cognition) fn advance_alias_postings(
        &mut self,
        stop: &CancellationToken,
    ) -> CognitionResult<bool> {
        let db = self.connection_mut()?;
        if complete(db)? {
            return Ok(false);
        }
        interruptible(db, stop, |db| advance(db, stop))
    }
}

fn interruptible<T>(
    db: &mut Connection,
    stop: &CancellationToken,
    operation: impl FnOnce(&mut Connection) -> CognitionResult<T>,
) -> CognitionResult<T> {
    if stop.is_cancelled() {
        return Err(aborted());
    }
    db.busy_timeout(std::time::Duration::from_millis(25))
        .map_err(db_error)?;
    db.pragma_update(None, "cache_spill", false)
        .map_err(db_error)?;
    db.pragma_update(None, "wal_autocheckpoint", 0)
        .map_err(db_error)?;
    let cancellation = stop.clone();
    db.progress_handler(1000, Some(move || cancellation.is_cancelled()));
    let interrupt = db.get_interrupt_handle();
    let cancellation = stop.clone();
    let watcher = tokio::spawn(async move {
        cancellation.cancelled().await;
        interrupt.interrupt();
    });
    let started = std::time::Instant::now();
    let result = operation(db);
    watcher.abort();
    db.progress_handler(0, None::<fn() -> bool>);
    butler_core::diagnostic!(
        "[alias-postings] batch_ms={}",
        started.elapsed().as_millis()
    );
    if stop.is_cancelled() {
        Err(aborted())
    } else {
        result
    }
}

fn advance(db: &mut Connection, stop: &CancellationToken) -> CognitionResult<bool> {
    let (_, log, checkpointed): (i64, i64, i64) = db
        .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(db_error)?;
    let page_size: i64 = db
        .pragma_query_value(None, "page_size", |r| r.get(0))
        .map_err(db_error)?;
    // Leave a pinned reader alone until it releases its snapshot.
    if (log - checkpointed) * (page_size + 24) > 4 * 1024 * 1024 {
        return Ok(true);
    }
    let tx = db.transaction().map_err(db_error)?;
    if state(&tx)?.is_none() {
        tx.execute_batch(schema::TABLES).map_err(db_error)?;
        tx.execute_batch(schema::INSTALL).map_err(db_error)?;
    }
    copy::batch(&tx, stop)?;
    if stop.is_cancelled() {
        return Err(aborted());
    }
    tx.commit().map_err(db_error)?;
    Ok(true)
}

fn aborted() -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryOperationAborted,
        "memory_operation_aborted",
    )
}

pub(in crate::cognition::graph) use writes::backfill;

pub(in crate::cognition::graph) fn installed(db: &Connection) -> CognitionResult<bool> {
    Ok(state(db)?.is_some())
}

pub(in crate::cognition::graph) fn fresh(db: &Connection) -> CognitionResult<()> {
    db.execute_batch(schema::TABLES).map_err(db_error)?;
    db.execute_batch(schema::FRESH).map_err(db_error)
}
