//! Entity revision alone does not cover structure edits. Remember the target's
//! graph, Task and Spec revisions too, so downgrade imports never overwrite edits.
use super::sql;
use crate::store::{Result, Transaction};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

pub(super) fn changed(tx: &Transaction<'_>, source: &str, work: &str) -> Result<bool> {
    let old = tx
        .query_row(sql::TARGET_VERSION, [source], |r| r.get::<_, String>(0))
        .optional()?;
    match old {
        Some(old) => Ok(old != fingerprint(tx, work)?),
        None => Ok(false),
    }
}
pub(super) fn remember(tx: &Transaction<'_>, source: &str, work: &str, batch: &str) -> Result<()> {
    let hash = fingerprint(tx, work)?;
    tx.execute(sql::REMEMBER_TARGET, params![source, work, hash, batch])?;
    Ok(())
}
fn fingerprint(tx: &Transaction<'_>, work: &str) -> Result<String> {
    let mut hash = Sha256::new();
    let row = tx.query_row(sql::TARGET_WORK_VERSION, [work], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, Option<i64>>(2)?,
        ))
    })?;
    hash.update(serde_json::to_vec(&row)?);
    let mut stmt = tx.prepare(sql::TARGET_TASK_VERSIONS)?;
    let mut rows = stmt.query([work])?;
    while let Some(row) = rows.next()? {
        hash.update(serde_json::to_vec(&(
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
        ))?);
    }
    Ok(format!("{:x}", hash.finalize()))
}
