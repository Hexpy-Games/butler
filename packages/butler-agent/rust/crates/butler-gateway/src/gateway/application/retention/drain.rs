//! Bounded event drain after terminal projection finalization.

use rusqlite::{Connection, OptionalExtension, Savepoint, params};

use super::super::{CachedSql, internal_continuation, storage::AppStorageError};
use super::compaction::{CompactResult, Step};

const DELETE_BATCH: usize = 256;
const REPLAY_TAIL: i64 = 200;

/// Removes one batch of the events the projection retained, then clears what
/// follows them: the replay-tail wait, continuation markers and identities.
pub(super) fn drain(
    tx: &Savepoint<'_>,
    turn: &str,
    high_water: i64,
) -> Result<Step, AppStorageError> {
    let through = high_water.min((latest_event_id(tx)? - REPLAY_TAIL).max(0));
    let deleted = delete_event_batch(tx, turn, through)?;
    let step = |result| Step { result, deleted };
    if deleted == DELETE_BATCH && retained_events_remain(tx, turn, through)? {
        return Ok(step(CompactResult::Pending));
    }
    if let Some(cursor) = replay_tail_cursor(tx, turn, high_water)? {
        return Ok(step(CompactResult::Waiting(cursor)));
    }
    if internal_continuation::clear_batch(tx, turn)? {
        return Ok(step(CompactResult::Pending));
    }
    clear_identity_batch(tx, turn)?;
    Ok(step(if identities_remain(tx, turn)? {
        CompactResult::Pending
    } else {
        CompactResult::Complete
    }))
}

pub(super) fn latest_event_id(db: &Connection) -> Result<i64, AppStorageError> {
    db.query_row_cached("SELECT COALESCE(MAX(id),0) FROM events", [], |row| {
        row.get(0)
    })
    .map_err(AppStorageError::sqlite)
}

fn delete_event_batch(
    tx: &Savepoint<'_>,
    turn: &str,
    through: i64,
) -> Result<usize, AppStorageError> {
    tx.execute_cached(
        "DELETE FROM events WHERE id IN (\
            SELECT events.id FROM events \
            JOIN app_terminal_turn_progress_rows retained \
                ON retained.source_event_id=events.id \
            WHERE retained.turn_id=?1 AND events.id<=?2 \
            ORDER BY events.id LIMIT ?3)",
        params![turn, through, DELETE_BATCH],
    )
    .map_err(AppStorageError::sqlite)
}

fn retained_events_remain(
    tx: &Savepoint<'_>,
    turn: &str,
    through: i64,
) -> Result<bool, AppStorageError> {
    tx.query_row_cached(
        "SELECT 1 FROM events \
         JOIN app_terminal_turn_progress_rows retained ON retained.source_event_id=events.id \
         WHERE retained.turn_id=?1 AND events.id<=?2 LIMIT 1",
        params![turn, through],
        |_| Ok(()),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(AppStorageError::sqlite)
}

fn replay_tail_cursor(
    tx: &Savepoint<'_>,
    turn: &str,
    high_water: i64,
) -> Result<Option<i64>, AppStorageError> {
    tx.query_row_cached(
        "SELECT MIN(events.id)+?2 FROM events \
         JOIN app_terminal_turn_progress_rows retained ON retained.source_event_id=events.id \
         WHERE retained.turn_id=?1 AND events.id<=?3",
        params![turn, REPLAY_TAIL, high_water],
        |row| row.get(0),
    )
    .map_err(AppStorageError::sqlite)
}

fn clear_identity_batch(tx: &Savepoint<'_>, turn: &str) -> Result<(), AppStorageError> {
    tx.execute_cached(
        "DELETE FROM app_progress_row_identities WHERE turn_id=?1 AND row_json IN (\
            SELECT row_json FROM app_progress_row_identities WHERE turn_id=?1 LIMIT 64)",
        [turn],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

fn identities_remain(tx: &Savepoint<'_>, turn: &str) -> Result<bool, AppStorageError> {
    tx.query_row_cached(
        "SELECT 1 FROM app_progress_row_identities WHERE turn_id=?1 LIMIT 1",
        [turn],
        |_| Ok(()),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(AppStorageError::sqlite)
}
