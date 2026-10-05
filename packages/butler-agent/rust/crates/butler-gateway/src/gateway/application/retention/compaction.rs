//! Bounded SQLite compaction for retained terminal turn projections.
//!
//! Two phases per turn. Finalize folds the turn's progress events into its
//! projection row, once. Drain then removes the events the projection
//! retained, a bounded batch per step, and clears the markers that follow.

use rusqlite::{Connection, OptionalExtension, Savepoint, params};
use serde_json::Value;

use super::super::{CachedSql, internal_continuation, storage::AppStorageError};
use super::drain::{drain, latest_event_id};
use super::sweep::{projected_event_types, terminal_states};

const SNAPSHOT_PAGE: usize = 64;

const TURN_SQL: &str = concat!(
    "SELECT state,chat_id FROM turns WHERE id=?1 AND state IN (",
    terminal_states!(),
    ")"
);
const RETAINED_SQL: &str = "SELECT progress_rows_json,source_event_high_water,terminal_state \
    FROM app_terminal_turn_projections WHERE turn_id=?1";
const SNAPSHOT_SQL: &str = "SELECT target_event_id,cursor_event_id \
    FROM app_terminal_turn_snapshot_state WHERE turn_id=?1";
const EVENTS_SQL: &str = concat!(
    "SELECT id,type,payload_json FROM events \
     WHERE turn_id=?1 AND turn_id<>'' AND id>?2 AND id<=?3 AND type IN (",
    projected_event_types!(),
    ") ORDER BY id LIMIT 65"
);
const NEWER_EVENT_SQL: &str = concat!(
    "SELECT 1 FROM events WHERE turn_id=?1 AND turn_id<>'' AND id>?2 AND type IN (",
    projected_event_types!(),
    ") LIMIT 1"
);

pub(super) enum CompactResult {
    Complete,
    Pending,
    Waiting(i64),
}

/// One compaction step of a turn and how many events it removed.
pub(super) struct Step {
    pub result: CompactResult,
    pub deleted: usize,
}

/// The projection row of a turn: its rows, high-water event id and state.
type Retained = (String, i64, String);

enum Finalized {
    /// More snapshot pages remain; the next step continues.
    Paged,
    /// The projection covers events through this id.
    Done(i64),
}

pub(super) fn compact(db: &mut Connection, turn: &str) -> Result<Step, AppStorageError> {
    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    let Some((state, chat)) = terminal_turn(&tx, turn)? else {
        return Ok(Step::of(CompactResult::Complete));
    };
    let existing = retained_projection(&tx, turn)?;
    let high_water = match &existing {
        Some(projection) if !needs_finalize(&tx, turn, &state, projection)? => projection.1,
        _ => match finalize(&tx, turn, &chat, &state, existing.as_ref())? {
            Finalized::Done(high_water) => high_water,
            Finalized::Paged => {
                tx.commit().map_err(AppStorageError::sqlite)?;
                return Ok(Step::of(CompactResult::Pending));
            }
        },
    };
    let step = drain(&tx, turn, high_water)?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(step)
}

impl Step {
    fn of(result: CompactResult) -> Self {
        Self { result, deleted: 0 }
    }
}

/// Whether the projection of a turn is out of date: a snapshot is unfinished,
/// the turn ended in another state, or events arrived that it does not cover.
fn needs_finalize(
    tx: &Savepoint<'_>,
    turn: &str,
    state: &str,
    projection: &Retained,
) -> Result<bool, AppStorageError> {
    if projection.2 != state {
        return Ok(true);
    }
    let unfinished = tx
        .query_row_cached(SNAPSHOT_SQL, [turn], |_| Ok(()))
        .optional()
        .map_err(AppStorageError::sqlite)?
        .is_some();
    if unfinished {
        return Ok(true);
    }
    tx.query_row_cached(NEWER_EVENT_SQL, params![turn, projection.1], |_| Ok(()))
        .optional()
        .map(|newer| newer.is_some())
        .map_err(AppStorageError::sqlite)
}

/// Folds the turn's events into its projection: one snapshot page per step,
/// the projection row written once, when the last page is in.
fn finalize(
    tx: &Savepoint<'_>,
    turn: &str,
    chat: &str,
    state: &str,
    existing: Option<&Retained>,
) -> Result<Finalized, AppStorageError> {
    let (target, cursor) = snapshot_bounds(tx, turn, existing)?;
    let rows = snapshot_rows(tx, turn, cursor, target)?;
    retain_rows(tx, turn, &rows)?;
    if rows.len() > SNAPSHOT_PAGE {
        update_cursor(tx, turn, rows[SNAPSHOT_PAGE - 1].0)?;
        return Ok(Finalized::Paged);
    }
    let delivery = delivery_metadata(tx, turn, target)?;
    let base = existing.map_or("[]", |value| value.0.as_str());
    upsert_projection(tx, turn, chat, state, base, delivery.as_ref(), target)?;
    tx.execute_cached(
        "DELETE FROM app_terminal_turn_snapshot_state WHERE turn_id=?1",
        [turn],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(Finalized::Done(target))
}

fn terminal_turn(
    tx: &Savepoint<'_>,
    turn: &str,
) -> Result<Option<(String, String)>, AppStorageError> {
    tx.query_row_cached(TURN_SQL, [turn], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
        .map_err(AppStorageError::sqlite)
}

fn retained_projection(
    tx: &Savepoint<'_>,
    turn: &str,
) -> Result<Option<Retained>, AppStorageError> {
    tx.query_row_cached(RETAINED_SQL, [turn], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })
    .optional()
    .map_err(AppStorageError::sqlite)
}

fn snapshot_bounds(
    tx: &Savepoint<'_>,
    turn: &str,
    existing: Option<&Retained>,
) -> Result<(i64, i64), AppStorageError> {
    let snapshot = tx
        .query_row_cached(SNAPSHOT_SQL, [turn], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if let Some(snapshot) = snapshot {
        return Ok(snapshot);
    }
    let target = latest_event_id(tx)?;
    let cursor = existing.map_or(0, |value| value.1);
    tx.execute_cached(
        "INSERT INTO app_terminal_turn_snapshot_state(\
            turn_id,target_event_id,cursor_event_id) VALUES(?1,?2,?3)",
        params![turn, target, cursor],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok((target, cursor))
}

fn snapshot_rows(
    tx: &Savepoint<'_>,
    turn: &str,
    cursor: i64,
    target: i64,
) -> Result<Vec<(i64, String, String)>, AppStorageError> {
    let mut statement = tx
        .prepare_cached(EVENTS_SQL)
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map(params![turn, cursor, target], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

fn retain_rows(
    tx: &Savepoint<'_>,
    turn: &str,
    rows: &[(i64, String, String)],
) -> Result<(), AppStorageError> {
    for (id, event_type, encoded) in rows.iter().take(SNAPSHOT_PAGE) {
        let Ok(value) = serde_json::from_str::<Value>(encoded) else {
            continue;
        };
        let object = value.as_object().cloned().unwrap_or_default();
        if event_type == "agent.turn_event" {
            if let Some(event) = object.get("event").and_then(Value::as_object) {
                internal_continuation::remember(tx, turn, event)?;
            }
            continue;
        }
        if event_type == "agent.turn_event.progress"
            && internal_continuation::retain_marker(tx, turn, &object, *id)?
        {
            continue;
        }
        if object.get("turn_id").and_then(Value::as_str) != Some(turn) {
            continue;
        }
        if let Some(row) = object.get("row").filter(|row| row.is_object()) {
            tx.execute_cached(
                "INSERT OR REPLACE INTO app_terminal_turn_progress_rows(\
                    turn_id,source_event_id,row_json) VALUES(?1,?2,?3)",
                params![turn, id, row.to_string()],
            )
            .map_err(AppStorageError::sqlite)?;
        }
    }
    Ok(())
}

fn update_cursor(tx: &Savepoint<'_>, turn: &str, cursor: i64) -> Result<(), AppStorageError> {
    tx.execute_cached(
        "UPDATE app_terminal_turn_snapshot_state SET cursor_event_id=?1 WHERE turn_id=?2",
        params![cursor, turn],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

fn upsert_projection(
    tx: &Savepoint<'_>,
    turn: &str,
    chat: &str,
    state: &str,
    rows: &str,
    delivery: Option<&String>,
    target: i64,
) -> Result<(), AppStorageError> {
    tx.execute_cached(
        "INSERT INTO app_terminal_turn_projections(\
            turn_id,chat_id,terminal_state,progress_rows_json,delivery_metadata_json,\
            source_event_high_water,compacted_at) \
         VALUES(?1,?2,?3,?4,?5,?6,datetime('now')) \
         ON CONFLICT(turn_id) DO UPDATE SET \
            terminal_state=excluded.terminal_state,\
            delivery_metadata_json=excluded.delivery_metadata_json,\
            source_event_high_water=excluded.source_event_high_water,\
            compacted_at=excluded.compacted_at",
        params![turn, chat, state, rows, delivery, target],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

fn delivery_metadata(
    db: &Connection,
    turn: &str,
    target: i64,
) -> Result<Option<String>, AppStorageError> {
    let encoded = db
        .query_row_cached(
            "SELECT payload_json FROM events WHERE turn_id=?1 AND turn_id<>'' AND id<=?2 \
             AND type='agent.turn_event' \
             AND json_extract(payload_json,'$.event.kind') \
                IN ('turn.completed','message.final.completed') \
             ORDER BY id DESC LIMIT 1",
            params![turn, target],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let Some(encoded) = encoded else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_str::<Value>(&encoded) else {
        return Ok(None);
    };
    let Some(payload) = value.pointer("/event/payload").and_then(Value::as_object) else {
        return Ok(None);
    };
    let Some(state) = payload.get("delivery_state").and_then(Value::as_str) else {
        return Ok(None);
    };
    Ok(Some(
        serde_json::json!({
            "delivery_state": state,
            "limitation_codes": payload
                .get("limitation_codes")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([])),
            "limitations": payload
                .get("limitations")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]))
        })
        .to_string(),
    ))
}
