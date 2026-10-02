//! Explicit rollback-window closure. Each call drops only one legacy object.
use super::{GraphRepository, db_error, schema, state};
use crate::cognition::{CognitionCode, CognitionError, CognitionResult};
use rusqlite::Connection;
use tokio_util::sync::CancellationToken;

impl GraphRepository {
    pub(in crate::cognition) fn drop_alias_legacy(
        &mut self,
        stop: &CancellationToken,
    ) -> CognitionResult<Option<bool>> {
        super::interruptible(self.connection_mut()?, stop, |db| drop_one(db, stop))
    }
}

fn drop_one(db: &mut Connection, stop: &CancellationToken) -> CognitionResult<Option<bool>> {
    match state(db)?.as_deref() {
        Some("fresh") => return Ok(Some(false)),
        Some("complete" | "reclaim") => {}
        _ => {
            return Err(CognitionError::new(
                CognitionCode::MemoryGraphUnavailable,
                "alias copy must complete before reclaim",
            ));
        }
    }
    if stop.is_cancelled() {
        return Err(super::aborted());
    }
    // Free allocation, without overwriting the redundant text still held
    // in canonical aliases and v2. Secure deletion would write the full GB.
    db.pragma_update(None, "secure_delete", false)
        .map_err(db_error)?;
    let tx = db.transaction().map_err(db_error)?;
    if state(&tx)?.as_deref() == Some("complete") {
        tx.execute_batch(schema::RECLAIM).map_err(db_error)?;
    }
    for name in [
        "idx_alias_postings_entity",
        "idx_alias_postings_scope_gram_node",
        "idx_alias_postings_alias",
        "idx_alias_postings_gram_source",
        "memory_alias_postings",
    ] {
        let present: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name=?1 AND type IN ('table','index'))",[name],|r|r.get(0)).map_err(db_error)?;
        if present {
            let kind = if name == "memory_alias_postings" {
                "TABLE"
            } else {
                "INDEX"
            };
            tx.execute_batch(&format!("DROP {kind} {name}"))
                .map_err(db_error)?;
            if kind == "TABLE" {
                tx.execute_batch(
                    "CREATE VIEW memory_alias_postings AS SELECT * FROM memory_alias_read_postings",
                )
                .map_err(db_error)?;
            }
            if stop.is_cancelled() {
                return Err(super::aborted());
            }
            tx.commit().map_err(db_error)?;
            return Ok(Some(true));
        }
    }
    Ok(None)
}
