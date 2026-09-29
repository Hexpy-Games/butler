use butler_turn::btcc::AccessMode;
use rusqlite::{Connection, OptionalExtension, Row};

use super::contracts::{AutomationRunSummary, AutomationSummary};
use crate::gateway::application::storage::{AppStorageCode, AppStorageError};

const COLUMNS: &str = "a.id,a.title,a.prompt_body,a.target_kind,a.target_session_id,a.interval_seconds,a.state,a.next_run_at,a.last_run_at,a.last_run_state,a.last_safe_error_code,a.run_count,a.consecutive_failure_count,a.created_at,a.updated_at,COALESCE(c.title,'Unavailable session'),a.access_mode,a.schedule_type,a.run_at,a.start_at";

#[derive(Clone)]
pub(super) struct AutomationRow {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub target_kind: String,
    pub target_id: String,
    pub interval: i64,
    pub schedule_type: String,
    pub run_at: Option<String>,
    pub start_at: Option<String>,
    pub state: String,
    pub next: Option<String>,
    pub last: Option<String>,
    pub last_state: String,
    pub last_error: Option<String>,
    pub runs: i64,
    pub failures: i64,
    pub created: String,
    pub updated: String,
    pub target_label: String,
    pub access: AccessMode,
}

pub(super) struct QueuedRunRow {
    pub run_id: String,
    pub trigger: String,
    pub placeholder_id: Option<String>,
    pub run_target_id: String,
    pub automation: AutomationRow,
}

pub(super) fn target(db: &Connection, id: &str) -> Result<(String, String), AppStorageError> {
    db.query_row("SELECT kind,title FROM chats WHERE id=?1", [id], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })
    .optional()
    .map_err(AppStorageError::sqlite)?
    .ok_or_else(|| AppStorageError::new(AppStorageCode::SessionNotFound, "Session not found."))
}

pub(super) fn get(db: &Connection, id: &str) -> Result<Option<AutomationRow>, AppStorageError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM app_automations a LEFT JOIN chats c ON c.id=a.target_session_id WHERE a.id=?1"
    );
    db.query_row(&sql, [id], row)
        .optional()
        .map_err(AppStorageError::sqlite)
}

pub(super) fn active(db: &Connection, id: &str) -> Result<AutomationRow, AppStorageError> {
    get(db, id)?
        .filter(|row| row.state != "deleted")
        .ok_or_else(not_found)
}

pub(super) fn list(
    db: &Connection,
    target_id: Option<&str>,
    include_deleted: bool,
) -> Result<Vec<AutomationRow>, AppStorageError> {
    let mut sql = format!(
        "SELECT {COLUMNS} FROM app_automations a LEFT JOIN chats c ON c.id=a.target_session_id WHERE 1=1"
    );
    if !include_deleted {
        sql.push_str(" AND a.state!='deleted'");
    }
    if target_id.is_some() {
        sql.push_str(" AND a.target_session_id=?1");
    }
    sql.push_str(" ORDER BY a.updated_at DESC LIMIT 200");
    let mut statement = db.prepare(&sql).map_err(AppStorageError::sqlite)?;
    let rows = if let Some(id) = target_id {
        statement.query_map([id], row)
    } else {
        statement.query_map([], row)
    }
    .map_err(AppStorageError::sqlite)?
    .collect::<Result<Vec<_>, _>>()
    .map_err(AppStorageError::sqlite)?;
    Ok(rows)
}

pub(super) fn due(db: &Connection, now: &str) -> Result<Vec<AutomationRow>, AppStorageError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM app_automations a LEFT JOIN chats c ON c.id=a.target_session_id WHERE a.state='enabled' AND a.next_run_at IS NOT NULL AND a.next_run_at<=?1 ORDER BY a.next_run_at LIMIT 20"
    );
    let mut statement = db.prepare(&sql).map_err(AppStorageError::sqlite)?;
    statement
        .query_map([now], row)
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

pub(super) fn next_due(db: &Connection) -> Result<Option<String>, AppStorageError> {
    db.query_row(
        "SELECT next_run_at FROM app_automations WHERE state='enabled' AND next_run_at IS NOT NULL ORDER BY next_run_at LIMIT 1",
        [], |row| row.get(0),
    ).optional().map_err(AppStorageError::sqlite)
}

pub(super) fn queued(db: &Connection) -> Result<Vec<QueuedRunRow>, AppStorageError> {
    let sql = format!(
        "SELECT r.id,r.trigger,r.queued_message_id,r.target_session_id,{COLUMNS} FROM app_automation_runs r JOIN app_automations a ON a.id=r.automation_id LEFT JOIN chats c ON c.id=a.target_session_id WHERE r.state='queued' AND a.state!='deleted' ORDER BY r.rowid LIMIT 20"
    );
    let mut statement = db.prepare(&sql).map_err(AppStorageError::sqlite)?;
    statement
        .query_map([], |item| {
            Ok(QueuedRunRow {
                run_id: item.get(0)?,
                trigger: item.get(1)?,
                placeholder_id: item.get(2)?,
                run_target_id: item.get(3)?,
                automation: row_at(item, 4)?,
            })
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

pub(super) fn runs(
    db: &Connection,
    id: &str,
) -> Result<Vec<AutomationRunSummary>, AppStorageError> {
    let mut statement = db.prepare("SELECT id,automation_id,target_session_id,state,trigger,started_at,completed_at,safe_error_code,queued_message_id,turn_id FROM app_automation_runs WHERE automation_id=?1 ORDER BY rowid DESC LIMIT 50").map_err(AppStorageError::sqlite)?;
    statement
        .query_map([id], run_row)
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

pub(super) fn run(db: &Connection, id: &str) -> Result<AutomationRunSummary, AppStorageError> {
    db.query_row("SELECT id,automation_id,target_session_id,state,trigger,started_at,completed_at,safe_error_code,queued_message_id,turn_id FROM app_automation_runs WHERE id=?1", [id], run_row).map_err(AppStorageError::sqlite)
}

pub(super) fn summary(value: AutomationRow) -> AutomationSummary {
    let label = if value.schedule_type == "once" {
        "Once".into()
    } else {
        interval_label(value.interval)
    };
    AutomationSummary {
        id: value.id,
        title: value.title,
        state: value.state,
        target_kind: value.target_kind,
        target_session_id: value.target_id,
        target_label: value.target_label,
        interval_seconds: value.interval,
        schedule_type: value.schedule_type,
        run_at: value.run_at,
        start_at: value.start_at,
        interval_label: label,
        access_mode: value.access,
        next_run_at: value.next,
        last_run_at: value.last,
        last_run_state: value.last_state,
        last_safe_error_code: value.last_error,
        run_count: value.runs,
        consecutive_failure_count: value.failures,
        created_at: value.created,
        updated_at: value.updated,
    }
}

pub(super) fn not_found() -> AppStorageError {
    AppStorageError::new(AppStorageCode::AutomationNotFound, "Schedule not found.")
}

fn row(item: &Row<'_>) -> rusqlite::Result<AutomationRow> {
    row_at(item, 0)
}
fn row_at(item: &Row<'_>, at: usize) -> rusqlite::Result<AutomationRow> {
    Ok(AutomationRow {
        id: item.get(at)?,
        title: item.get(at + 1)?,
        prompt: item.get(at + 2)?,
        target_kind: item.get(at + 3)?,
        target_id: item.get(at + 4)?,
        interval: item.get(at + 5)?,
        schedule_type: item.get(at + 17)?,
        run_at: item.get(at + 18)?,
        start_at: item.get(at + 19)?,
        state: item.get(at + 6)?,
        next: item.get(at + 7)?,
        last: item.get(at + 8)?,
        last_state: item.get(at + 9)?,
        last_error: item.get(at + 10)?,
        runs: item.get(at + 11)?,
        failures: item.get(at + 12)?,
        created: item.get(at + 13)?,
        updated: item.get(at + 14)?,
        target_label: item.get(at + 15)?,
        access: access_at(item, at + 16)?,
    })
}
/// The stored access mode in column `at`; migration fills every row.
fn access_at(item: &Row<'_>, at: usize) -> rusqlite::Result<AccessMode> {
    let stored: String = item.get(at)?;
    serde_json::from_value(serde_json::Value::String(stored)).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(at, rusqlite::types::Type::Text, Box::new(error))
    })
}
fn run_row(item: &Row<'_>) -> rusqlite::Result<AutomationRunSummary> {
    Ok(AutomationRunSummary {
        id: item.get(0)?,
        automation_id: item.get(1)?,
        target_session_id: item.get(2)?,
        state: item.get(3)?,
        trigger: item.get(4)?,
        started_at: item.get(5)?,
        completed_at: item.get(6)?,
        safe_error_code: item.get(7)?,
        queued_message_id: item.get(8)?,
        turn_id: item.get(9)?,
    })
}
fn interval_label(seconds: i64) -> String {
    match seconds {
        600 => "10 minutes".into(),
        1800 => "30 minutes".into(),
        3600 => "1 hour".into(),
        value if value % 3600 == 0 => format!("{} hours", value / 3600),
        value if value % 60 == 0 => format!("{} minutes", value / 60),
        value => format!("{value} seconds"),
    }
}
