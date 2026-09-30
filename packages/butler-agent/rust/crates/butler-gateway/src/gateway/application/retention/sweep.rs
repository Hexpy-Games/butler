//! Which terminal turns still need retention work, and the persisted position
//! before which none do.
//!
//! A turn needs work when compaction has not finished with it. Every
//! `CompactResult::Pending` and `Waiting` cause leaves one of these marks:
//! no projection row, a paged snapshot in progress, progress identities or
//! continuation markers left to clear, retained progress events not yet
//! deleted, or events the projection has not folded in.

use rusqlite::{Connection, OptionalExtension, params};

use super::super::{CachedSql, storage::AppStorageError};

/// Terminal turn states, as an SQL list.
macro_rules! terminal_states {
    () => {
        "'delivered','failed','cancelled','runtime_fault'"
    };
}
/// The event types a projection folds in, as an SQL list.
macro_rules! projected_event_types {
    () => {
        "'agent.turn_event','progress.summary','agent.turn_event.progress'"
    };
}
pub(super) use projected_event_types;
pub(super) use terminal_states;

/// SQL over `turns t`: the turn still needs compaction work.
macro_rules! needs_work {
    () => {
        concat!(
            "(NOT EXISTS (SELECT 1 FROM app_terminal_turn_projections p WHERE p.turn_id=t.id) \
             OR EXISTS (SELECT 1 FROM app_terminal_turn_snapshot_state s WHERE s.turn_id=t.id) \
             OR EXISTS (SELECT 1 FROM app_progress_row_identities i WHERE i.turn_id=t.id) \
             OR EXISTS (SELECT 1 FROM app_internal_continuation_progress_events c \
                        WHERE c.turn_id=t.id) \
             OR EXISTS (SELECT 1 FROM app_terminal_turn_progress_rows r \
                        JOIN events e ON e.id=r.source_event_id WHERE r.turn_id=t.id) \
             OR EXISTS (SELECT 1 FROM app_terminal_turn_projections p WHERE p.turn_id=t.id \
                AND (p.terminal_state<>t.state OR EXISTS (SELECT 1 FROM events e \
                     WHERE e.turn_id=t.id AND e.turn_id<>'' \
                     AND e.id>p.source_event_high_water AND e.type IN (",
            projected_event_types!(),
            "))))) "
        )
    };
}

const PAGE: i64 = 32;

const NEEDING_WORK_SQL: &str = concat!(
    "SELECT t.rowid,t.id FROM turns t WHERE t.rowid>?1 AND t.state IN (",
    terminal_states!(),
    ") AND ",
    needs_work!(),
    "AND t.rowid<=?2 ORDER BY t.rowid"
);

/// The first turn, past `after`, that is running or still needs work; every
/// turn before it is settled.
const FIRST_UNSETTLED_SQL: &str = concat!(
    "SELECT t.rowid FROM turns t WHERE t.rowid>?1 AND (t.state NOT IN (",
    terminal_states!(),
    ") OR ",
    needs_work!(),
    ") AND t.rowid<=?2 ORDER BY t.rowid LIMIT 1"
);

/// Bound predicate evaluation even when almost every turn is already settled.
/// SQL LIMIT on matching rows alone can scan the entire owner-scale table.
fn page_end(db: &Connection, after: i64) -> Result<Option<i64>, AppStorageError> {
    db.query_row_cached(
        "SELECT rowid FROM turns WHERE rowid>?1 ORDER BY rowid LIMIT 1 OFFSET ?2",
        params![after, PAGE - 1],
        |row| row.get(0),
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}

/// Up to one page of terminal turns after `after` that need work, and where the
/// next page starts (`None` when this was the last).
pub(super) fn needing_work_page(
    db: &Connection,
    after: i64,
) -> Result<(Vec<String>, Option<i64>), AppStorageError> {
    let end = page_end(db, after)?;
    let mut statement = db
        .prepare_cached(NEEDING_WORK_SQL)
        .map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map(params![after, end.unwrap_or(i64::MAX)], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    Ok((rows.into_iter().map(|row| row.1).collect(), end))
}

/// The rowid up to which every turn was settled when last recorded. A turn
/// row deleted from the end lets a new one reuse its rowid, so the position
/// never passes the newest turn.
pub(super) fn read_watermark(db: &Connection) -> Result<i64, AppStorageError> {
    let stored = db
        .query_row_cached(
            "SELECT turn_rowid FROM app_retention_sweep WHERE id=1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .unwrap_or(0);
    let newest: i64 = db
        .query_row_cached("SELECT COALESCE(MAX(rowid),0) FROM turns", [], |row| {
            row.get(0)
        })
        .map_err(AppStorageError::sqlite)?;
    Ok(stored.min(newest))
}

/// Checks at most one page toward the next durable watermark. Returns the
/// settled cursor and whether another page is needed.
pub(super) fn scan_watermark_page(
    db: &Connection,
    from: i64,
) -> Result<(i64, bool), AppStorageError> {
    let end = page_end(db, from)?;
    let first_unsettled: Option<i64> = db
        .query_row_cached(
            FIRST_UNSETTLED_SQL,
            params![from, end.unwrap_or(i64::MAX)],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if let Some(rowid) = first_unsettled {
        return Ok(((rowid - 1).max(from), false));
    }
    if let Some(end) = end {
        return Ok((end, true));
    }
    let newest: i64 = db
        .query_row_cached("SELECT COALESCE(MAX(rowid),0) FROM turns", [], |row| {
            row.get(0)
        })
        .map_err(AppStorageError::sqlite)?;
    Ok((newest.max(from), false))
}

/// Persist only the completed scan, avoiding a disk write per page.
pub(super) fn write_watermark(db: &Connection, settled: i64) -> Result<(), AppStorageError> {
    db.execute_cached(
        "INSERT INTO app_retention_sweep(id,turn_rowid) VALUES(1,?1) \
         ON CONFLICT(id) DO UPDATE SET turn_rowid=excluded.turn_rowid",
        [settled],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}
