//! Keyset batches bound decoded source metadata and release BTCC's lane.
use super::{
    batches,
    estimate::{BATCH_BYTES, BATCH_ROWS},
    sql,
};
use crate::store::{Context, Result, Transaction};
use rusqlite::params;

pub(super) fn works(tx: &Transaction<'_>, ctx: &Context, cursor: &mut String) -> Result<bool> {
    let ids = tx
        .prepare(sql::WORK_BATCH)?
        .query_map(params![cursor.as_str(), BATCH_ROWS], |r| {
            r.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut used_rows = 0;
    let mut used_bytes = 0;
    for id in &ids {
        let (rows, bytes) = footprint(tx, id)?;
        if used_rows > 0 && (used_rows + rows > BATCH_ROWS || used_bytes + bytes > BATCH_BYTES) {
            break;
        }
        // An indivisible source larger than the cap is streamed alone, as in
        // source::load. Never truncate history to satisfy the batching budget.
        batches::import_work(tx, ctx, id)?;
        *cursor = id.clone();
        used_rows += rows;
        used_bytes += bytes;
    }
    Ok(!ids.is_empty())
}

fn footprint(tx: &Transaction<'_>, id: &str) -> Result<(u64, u64)> {
    let mut count = 0;
    let mut bytes = 0;
    // Indexed point/range reads include every source field, not just titles.
    for statement in [sql::WORK, sql::DELEGATION].into_iter().chain(sql::HISTORY) {
        let mut stmt = tx.prepare(statement)?;
        let mut rows = stmt.query([id])?;
        while let Some(row) = rows.next()? {
            count += 1;
            for i in 0..row.as_ref().column_count() {
                bytes += match row.get_ref(i)? {
                    rusqlite::types::ValueRef::Text(value)
                    | rusqlite::types::ValueRef::Blob(value) => value.len() as u64,
                    _ => 8,
                };
            }
        }
    }
    Ok((count, bytes))
}
