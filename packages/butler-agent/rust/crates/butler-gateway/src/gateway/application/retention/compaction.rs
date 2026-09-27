//! Bounded SQLite compaction for retained terminal turn projections.

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::Value;

use super::super::{internal_continuation, storage::AppStorageError};

const SNAPSHOT_PAGE: usize = 64;
const DELETE_BATCH: usize = 8;
const REPLAY_TAIL: i64 = 200;

const TERMINAL_PAGE_SQL: &str = "SELECT rowid,id FROM turns \
    WHERE rowid>?1 AND state IN ('delivered','failed','cancelled','runtime_fault') \
    ORDER BY rowid LIMIT 33";
const TURN_SQL: &str = "SELECT state,chat_id FROM turns \
    WHERE id=?1 AND state IN ('delivered','failed','cancelled','runtime_fault')";
const RETAINED_SQL: &str = "SELECT progress_rows_json,source_event_high_water \
    FROM app_terminal_turn_projections WHERE turn_id=?1";
const SNAPSHOT_SQL: &str = "SELECT target_event_id,cursor_event_id \
    FROM app_terminal_turn_snapshot_state WHERE turn_id=?1";
const EVENTS_SQL: &str = "SELECT id,type,payload_json FROM events \
    WHERE turn_id=?1 AND turn_id<>'' AND id>?2 AND id<=?3 \
    AND type IN ('agent.turn_event','progress.summary','agent.turn_event.progress') \
    ORDER BY id LIMIT 65";

pub(super) enum CompactResult {
    Complete,
    Pending,
    Waiting(i64),
}

pub(super) fn terminal_page(
    db: &mut Connection,
    after: i64,
) -> Result<(Vec<String>, Option<i64>), AppStorageError> {
    let mut statement = db
        .prepare(TERMINAL_PAGE_SQL)
        .map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map([after], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let more = rows.len() > 32;
    let page = rows.into_iter().take(32).collect::<Vec<_>>();
    let next = page.last().map(|row| row.0).unwrap_or(after);
    Ok((
        page.into_iter().map(|row| row.1).collect(),
        more.then_some(next),
    ))
}

pub(super) fn compact(db: &mut Connection, turn: &str) -> Result<CompactResult, AppStorageError> {
    let tx = db.transaction().map_err(AppStorageError::sqlite)?;
    let Some((state, chat)) = terminal_turn(&tx, turn)? else {
        return Ok(CompactResult::Complete);
    };
    let existing = retained_projection(&tx, turn)?;
    let (target, cursor) = snapshot_bounds(&tx, turn, existing.as_ref())?;
    let rows = snapshot_rows(&tx, turn, cursor, target)?;
    retain_rows(&tx, turn, &rows)?;

    if rows.len() > SNAPSHOT_PAGE {
        update_cursor(&tx, turn, rows[SNAPSHOT_PAGE - 1].0)?;
        tx.commit().map_err(AppStorageError::sqlite)?;
        return Ok(CompactResult::Pending);
    }

    let delivery = delivery_metadata(&tx, turn, target)?;
    let base = existing.as_ref().map_or("[]", |value| value.0.as_str());
    upsert_projection(&tx, turn, &chat, &state, base, delivery.as_ref(), target)?;
    tx.execute(
        "DELETE FROM app_terminal_turn_snapshot_state WHERE turn_id=?1",
        [turn],
    )
    .map_err(AppStorageError::sqlite)?;

    let latest = latest_event_id(&tx)?;
    let through = target.min((latest - REPLAY_TAIL).max(0));
    delete_event_batch(&tx, turn, through)?;
    if retained_events_remain(&tx, turn, through)? {
        tx.commit().map_err(AppStorageError::sqlite)?;
        return Ok(CompactResult::Pending);
    }
    if let Some(cursor) = replay_tail_cursor(&tx, turn, target)? {
        tx.commit().map_err(AppStorageError::sqlite)?;
        return Ok(CompactResult::Waiting(cursor));
    }
    if internal_continuation::clear_batch(&tx, turn)? {
        tx.commit().map_err(AppStorageError::sqlite)?;
        return Ok(CompactResult::Pending);
    }
    clear_identity_batch(&tx, turn)?;
    let pending = identities_remain(&tx, turn)?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(if pending {
        CompactResult::Pending
    } else {
        CompactResult::Complete
    })
}

fn terminal_turn(
    tx: &Transaction<'_>,
    turn: &str,
) -> Result<Option<(String, String)>, AppStorageError> {
    tx.query_row(TURN_SQL, [turn], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
        .map_err(AppStorageError::sqlite)
}

fn retained_projection(
    tx: &Transaction<'_>,
    turn: &str,
) -> Result<Option<(String, i64)>, AppStorageError> {
    tx.query_row(RETAINED_SQL, [turn], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
        .map_err(AppStorageError::sqlite)
}

fn snapshot_bounds(
    tx: &Transaction<'_>,
    turn: &str,
    existing: Option<&(String, i64)>,
) -> Result<(i64, i64), AppStorageError> {
    let snapshot = tx
        .query_row(SNAPSHOT_SQL, [turn], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if let Some(snapshot) = snapshot {
        return Ok(snapshot);
    }
    let target = latest_event_id(tx)?;
    let cursor = existing.map_or(0, |value| value.1);
    tx.execute(
        "INSERT INTO app_terminal_turn_snapshot_state(\
            turn_id,target_event_id,cursor_event_id) VALUES(?1,?2,?3)",
        params![turn, target, cursor],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok((target, cursor))
}

fn snapshot_rows(
    tx: &Transaction<'_>,
    turn: &str,
    cursor: i64,
    target: i64,
) -> Result<Vec<(i64, String, String)>, AppStorageError> {
    let mut statement = tx.prepare(EVENTS_SQL).map_err(AppStorageError::sqlite)?;
    statement
        .query_map(params![turn, cursor, target], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

fn retain_rows(
    tx: &Transaction<'_>,
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
            tx.execute(
                "INSERT OR REPLACE INTO app_terminal_turn_progress_rows(\
                    turn_id,source_event_id,row_json) VALUES(?1,?2,?3)",
                params![turn, id, row.to_string()],
            )
            .map_err(AppStorageError::sqlite)?;
        }
    }
    Ok(())
}

fn update_cursor(tx: &Transaction<'_>, turn: &str, cursor: i64) -> Result<(), AppStorageError> {
    tx.execute(
        "UPDATE app_terminal_turn_snapshot_state SET cursor_event_id=?1 WHERE turn_id=?2",
        params![cursor, turn],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

fn upsert_projection(
    tx: &Transaction<'_>,
    turn: &str,
    chat: &str,
    state: &str,
    rows: &str,
    delivery: Option<&String>,
    target: i64,
) -> Result<(), AppStorageError> {
    tx.execute(
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

fn latest_event_id(db: &Connection) -> Result<i64, AppStorageError> {
    db.query_row("SELECT COALESCE(MAX(id),0) FROM events", [], |row| {
        row.get(0)
    })
    .map_err(AppStorageError::sqlite)
}

fn delete_event_batch(
    tx: &Transaction<'_>,
    turn: &str,
    through: i64,
) -> Result<(), AppStorageError> {
    tx.execute(
        &format!(
            "DELETE FROM events WHERE id IN (\
                SELECT events.id FROM events \
                JOIN app_terminal_turn_progress_rows retained \
                    ON retained.source_event_id=events.id \
                WHERE retained.turn_id=?1 AND events.id<=?2 \
                ORDER BY events.id LIMIT {DELETE_BATCH})"
        ),
        params![turn, through],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

fn retained_events_remain(
    tx: &Transaction<'_>,
    turn: &str,
    through: i64,
) -> Result<bool, AppStorageError> {
    tx.query_row(
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
    tx: &Transaction<'_>,
    turn: &str,
    target: i64,
) -> Result<Option<i64>, AppStorageError> {
    tx.query_row(
        "SELECT MIN(events.id)+?2 FROM events \
         JOIN app_terminal_turn_progress_rows retained ON retained.source_event_id=events.id \
         WHERE retained.turn_id=?1 AND events.id<=?3",
        params![turn, REPLAY_TAIL, target],
        |row| row.get(0),
    )
    .map_err(AppStorageError::sqlite)
}

fn clear_identity_batch(tx: &Transaction<'_>, turn: &str) -> Result<(), AppStorageError> {
    tx.execute(
        "DELETE FROM app_progress_row_identities WHERE turn_id=?1 AND row_json IN (\
            SELECT row_json FROM app_progress_row_identities WHERE turn_id=?1 LIMIT 64)",
        [turn],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

fn identities_remain(tx: &Transaction<'_>, turn: &str) -> Result<bool, AppStorageError> {
    tx.query_row(
        "SELECT 1 FROM app_progress_row_identities WHERE turn_id=?1 LIMIT 1",
        [turn],
        |_| Ok(()),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(AppStorageError::sqlite)
}

fn delivery_metadata(
    db: &Connection,
    turn: &str,
    target: i64,
) -> Result<Option<String>, AppStorageError> {
    let encoded = db
        .query_row(
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
