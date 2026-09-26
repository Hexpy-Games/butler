//! App SQLite conversation, attachment and execution observations.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::super::super::super::storage::AppStorageError;
use super::calendar::{self, Calendar};
use super::view::{self, add, set_source};
use crate::public_text::sanitize_public_text;

const MAX_ROWS: usize = 20_000;

pub(super) fn populate(
    db: &Connection,
    project_id: &str,
    calendar: &Calendar,
    view: &mut Value,
) -> Result<(), AppStorageError> {
    read_conversations(db, project_id, calendar, view)?;
    read_artifacts(db, project_id, calendar, view)?;
    read_turns(db, project_id, calendar, view)?;
    if view["sources"].as_object().map_or(0, serde_json::Map::len) > MAX_ROWS {
        return Err(limit_error());
    }
    view["sessionHistoryAvailable"] = Value::Bool(true);
    Ok(())
}

fn read_conversations(
    db: &Connection,
    project_id: &str,
    calendar: &Calendar,
    view: &mut Value,
) -> Result<(), AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT c.id,c.title,max(m.created_at) FROM chats c \
             JOIN messages m ON m.chat_id=c.id WHERE c.project_id=?1 \
             AND m.created_at>=?2 AND m.created_at<?3 AND m.role IN ('user','assistant') \
             AND m.status IN ('sent','delivered') AND NOT \
             (m.role='assistant' AND m.safe_error_code IS NOT NULL AND m.safe_error_code IN \
             ('app_turn_queue_failed','goal_completion_incomplete')) \
             GROUP BY c.id ORDER BY c.id LIMIT ?4",
        )
        .map_err(AppStorageError::sqlite)?;
    for (index, day) in calendar.days.iter().enumerate() {
        let rows = statement
            .query_map(
                params![
                    project_id,
                    calendar::iso(day.start_ms),
                    calendar::iso(day.end_ms),
                    MAX_ROWS + 1
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(AppStorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppStorageError::sqlite)?;
        if rows.len() > MAX_ROWS {
            return Err(limit_error());
        }
        for (id, raw_title, at) in rows {
            let key = format!("session:{id}:{}", day.date);
            let title = sanitize_public_text(&raw_title, "");
            set_source(
                view,
                &key,
                json!({"title":title,"at":at,"session":{"id":id,"title":title}}),
            );
            add(view, &["activity"], index, "conversations", &key);
        }
    }
    Ok(())
}

fn read_artifacts(
    db: &Connection,
    project_id: &str,
    calendar: &Calendar,
    view: &mut Value,
) -> Result<(), AppStorageError> {
    let Some(first) = calendar.days.first() else {
        return Ok(());
    };
    let mut statement = db
        .prepare(
            "SELECT f.id,f.safe_name,f.sha256,min(m.created_at),c.id,c.title \
             FROM chats c JOIN messages m ON m.chat_id=c.id \
             JOIN message_attachments a ON a.message_id=m.id JOIN message_files f ON f.id=a.file_id \
             WHERE c.project_id=?1 AND m.role='assistant' AND m.status='delivered' AND NOT \
             (m.role='assistant' AND m.safe_error_code IS NOT NULL AND m.safe_error_code IN \
             ('app_turn_queue_failed','goal_completion_incomplete')) \
             GROUP BY f.id HAVING min(m.created_at)>=?2 AND min(m.created_at)<?3 \
             ORDER BY min(m.created_at),f.id LIMIT ?4",
        )
        .map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map(
            params![
                project_id,
                calendar::iso(first.start_ms),
                calendar.observed_at,
                MAX_ROWS + 1
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    if rows.len() > MAX_ROWS {
        return Err(limit_error());
    }
    for (id, raw_title, revision, at, session_id, raw_session_title) in rows {
        let Some(day) = view::day_index(&calendar.days, &at) else {
            continue;
        };
        let key = format!("artifact:{id}");
        let title = sanitize_public_text(&raw_title, "");
        let session_title = sanitize_public_text(&raw_session_title, "");
        set_source(
            view,
            &key,
            json!({
                "title":title,
                "at":at,
                "source":{"id":format!("artifact-{id}"),"kind":"artifact","revision":revision},
                "session":{"id":session_id,"title":session_title},
            }),
        );
        add(view, &["materials"], day, "artifacts", &key);
        add(view, &["materialTypes"], day, "artifacts", &key);
        add(view, &["activity"], day, "materials", &key);
    }
    Ok(())
}

fn read_turns(
    db: &Connection,
    project_id: &str,
    calendar: &Calendar,
    view: &mut Value,
) -> Result<(), AppStorageError> {
    let Some(first) = calendar.days.first() else {
        return Ok(());
    };
    let mut statement = db
        .prepare(
            "SELECT t.id,t.chat_id,c.title,t.state,t.created_at FROM chats c \
             JOIN turns t ON t.chat_id=c.id WHERE c.project_id=?1 AND t.updated_at>=?2 \
             AND t.state IN ('delivered','failed','cancelled','runtime_fault') \
             ORDER BY t.id LIMIT ?3",
        )
        .map_err(AppStorageError::sqlite)?;
    let turns = statement
        .query_map(
            params![project_id, calendar::iso(first.start_ms), MAX_ROWS + 1],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    if turns.len() > MAX_ROWS {
        return Err(limit_error());
    }
    let indexed = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name='events_turn_id_idx'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .is_some();
    let match_expression = if indexed {
        "turn_id<>'' AND turn_id=?1"
    } else {
        "(json_extract(payload_json,'$.turn_id')=?1 OR json_extract(payload_json,'$.turn.id')=?1)"
    };
    let query = format!(
        "SELECT json_extract(payload_json,'$.turn.updated_at') FROM events \
         WHERE type='turn.state_changed' AND {match_expression} AND json_valid(payload_json) \
         AND json_extract(payload_json,'$.turn.state')=?2 ORDER BY id DESC LIMIT 1"
    );
    for (id, session_id, raw_title, state, created_at) in turns {
        let terminal_at: Option<String> = db
            .query_row(&query, params![id, state], |row| row.get(0))
            .optional()
            .map_err(AppStorageError::sqlite)?
            .flatten();
        let Some(terminal_at) = terminal_at else {
            view["execution"]["excluded"] =
                json!(view["execution"]["excluded"].as_u64().unwrap_or(0) + 1);
            continue;
        };
        let (Ok(started), Ok(ended)) = (
            chrono::DateTime::parse_from_rfc3339(&created_at),
            chrono::DateTime::parse_from_rfc3339(&terminal_at),
        ) else {
            view["execution"]["excluded"] =
                json!(view["execution"]["excluded"].as_u64().unwrap_or(0) + 1);
            continue;
        };
        let duration = ended.timestamp_millis() - started.timestamp_millis();
        if duration < 0 {
            view["execution"]["excluded"] =
                json!(view["execution"]["excluded"].as_u64().unwrap_or(0) + 1);
            continue;
        }
        let Some(day) = view::day_index(&calendar.days, &terminal_at) else {
            continue;
        };
        let title = sanitize_public_text(&raw_title, "");
        let key = format!("turn:{id}");
        set_source(
            view,
            &key,
            json!({
                "title":title,
                "at":terminal_at,
                "session":{"id":session_id,"title":title},
                "durationMs":duration,
            }),
        );
        let outcome = match state.as_str() {
            "delivered" => "delivered",
            "cancelled" => "cancelled",
            _ => "failed",
        };
        add(view, &["execution", "outcomes"], day, outcome, &key);
        let duration_bucket = if duration < 30_000 {
            0
        } else if duration < 120_000 {
            1
        } else if duration < 600_000 {
            2
        } else {
            3
        };
        add(
            view,
            &["execution", "duration"],
            duration_bucket,
            outcome,
            &key,
        );
    }
    Ok(())
}

fn limit_error() -> AppStorageError {
    AppStorageError::new(
        "project_statistics_limit",
        "Statistics exceed the bounded read limit.",
    )
}
