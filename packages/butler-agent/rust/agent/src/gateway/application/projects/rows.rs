//! Source project-row order and public projection on the one App SQLite lane.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::json;

use super::{AppProjectSource, AppProjectSummary, AppSessionSummary};
use crate::gateway::application::{
    AppIdentityClock, EventSubscribers, events, storage::AppStorageError,
};
use crate::public_text::trim_js_whitespace;

pub(super) struct ProjectRow {
    id: String,
    pub(super) display_name: String,
    pub(super) status: String,
    workspace_label: String,
    safe_path_label: String,
    ledger_project_id: Option<String>,
    pub(super) pinned: bool,
    pub(super) archived: bool,
    error_summary: Option<String>,
    updated_at: String,
    created_at: String,
}

fn decode(row: &Row<'_>) -> rusqlite::Result<ProjectRow> {
    Ok(ProjectRow {
        id: row.get(0)?,
        display_name: row.get(1)?,
        status: row.get(2)?,
        workspace_label: row.get(4)?,
        safe_path_label: row.get(5)?,
        ledger_project_id: row.get(6)?,
        pinned: row.get::<_, i64>(7)? == 1,
        archived: row.get::<_, i64>(8)? == 1,
        error_summary: row.get(9)?,
        updated_at: row.get(10)?,
        created_at: row.get(11)?,
    })
}

const SELECT: &str = "SELECT id,display_name,status,workspace_path,workspace_label,safe_path_label,ledger_project_id,pinned,archived,error_summary,updated_at,created_at FROM projects";

pub(super) fn list(db: &Connection) -> Result<Vec<ProjectRow>, AppStorageError> {
    let mut statement = db
        .prepare(&format!(
            "{SELECT} WHERE archived=0 ORDER BY pinned DESC,updated_at DESC,display_name ASC"
        ))
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map([], decode)
        .map_err(AppStorageError::sqlite)?
        .map(|row| row.map_err(AppStorageError::sqlite))
        .collect()
}

pub(super) fn archives(
    db: &Connection,
) -> Result<Vec<(String, AppProjectSummary)>, AppStorageError> {
    let mut statement = db
        .prepare(&format!(
            "{SELECT} WHERE archived=1 ORDER BY updated_at DESC,created_at DESC"
        ))
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map([], decode)
        .map_err(AppStorageError::sqlite)?
        .map(|row| {
            let row = row.map_err(AppStorageError::sqlite)?;
            let key = format!("{}:{}", row.updated_at, row.created_at);
            Ok((key, summary(row, None)))
        })
        .collect()
}

fn active_by_path(db: &Connection, path: &str) -> Result<Option<ProjectRow>, AppStorageError> {
    let row = db
        .query_row(
            &format!("{SELECT} WHERE workspace_path=?1 AND archived=0"),
            [path],
            decode,
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if row
        .as_ref()
        .and_then(|row| row.ledger_project_id.as_ref())
        .is_some_and(|id| !safe_ledger_id(id))
    {
        return Err(AppStorageError::new(
            "app_project_ledger_identity_invalid",
            "app_project_ledger_identity_invalid",
        ));
    }
    Ok(row)
}

pub(super) fn active_by_id(
    db: &Connection,
    id: &str,
) -> Result<Option<ProjectRow>, AppStorageError> {
    db.query_row(
        &format!("{SELECT} WHERE id=?1 AND archived=0"),
        [id],
        decode,
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}

pub(super) fn any_by_id(db: &Connection, id: &str) -> Result<Option<ProjectRow>, AppStorageError> {
    db.query_row(&format!("{SELECT} WHERE id=?1"), [id], decode)
        .optional()
        .map_err(AppStorageError::sqlite)
}

pub(super) fn create_or_reuse(
    db: &Connection,
    subscribers: &EventSubscribers,
    clock: &dyn AppIdentityClock,
    workspace: &Path,
    display_name: Option<&str>,
    source: AppProjectSource,
) -> Result<(AppProjectSummary, bool, Option<AppStorageError>), AppStorageError> {
    let workspace_path = workspace.to_string_lossy().into_owned();
    if let Some(row) = active_by_path(db, &workspace_path)? {
        return Ok((summary(row, None), false, None));
    }
    let workspace_label = workspace
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Project".to_owned());
    let display_name = display_name
        .map(trim_js_whitespace)
        .filter(|name| !name.is_empty())
        .unwrap_or(&workspace_label);
    let display_name = if source == AppProjectSource::Scratch {
        display_name.to_owned()
    } else {
        clip_utf16(display_name, 80)
    };
    let display_name = if display_name.is_empty() {
        "Project".to_owned()
    } else {
        display_name
    };
    let id = next_id(db, clock, &display_name)?;
    let now = clock.now_iso();
    db.execute(
        "INSERT INTO projects(id,display_name,status,workspace_path,workspace_label,safe_path_label,ledger_project_id,pinned,archived,error_summary,created_at,updated_at) \
         VALUES(?1,?2,'active',?3,?4,?4,?1,0,0,NULL,?5,?5)",
        params![id, display_name, workspace_path, workspace_label, now],
    ).map_err(AppStorageError::sqlite)?;
    let row = active_by_id(db, &id)?.ok_or_else(|| {
        AppStorageError::new("project_creation_failed", "Failed to create project.")
    })?;
    let project = summary(row, None);
    let event_error = append_created(db, subscribers, clock, &project).err();
    Ok((project, true, event_error))
}

pub(super) fn insert_scratch(
    db: &Connection,
    clock: &dyn AppIdentityClock,
    workspace: &Path,
    display_name: &str,
) -> Result<AppProjectSummary, AppStorageError> {
    let workspace_path = workspace.to_string_lossy().into_owned();
    if active_by_path(db, &workspace_path)?.is_some() {
        return Err(AppStorageError::new(
            "project_workspace_already_registered",
            "Project workspace is already registered.",
        ));
    }
    let workspace_label = workspace
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Project".to_owned());
    let display_name = trim_js_whitespace(display_name);
    let display_name = if display_name.is_empty() {
        workspace_label.as_str()
    } else {
        display_name
    };
    let id = next_id(db, clock, display_name)?;
    let now = clock.now_iso();
    db.execute(
        "INSERT INTO projects(id,display_name,status,workspace_path,workspace_label,safe_path_label,ledger_project_id,pinned,archived,error_summary,created_at,updated_at) \
         VALUES(?1,?2,'active',?3,?4,?4,?1,0,0,NULL,?5,?5)",
        params![id, display_name, workspace_path, workspace_label, now],
    )
    .map_err(AppStorageError::sqlite)?;
    let row = active_by_id(db, &id)?.ok_or_else(|| {
        AppStorageError::new("project_creation_failed", "Failed to create project.")
    })?;
    Ok(summary(row, None))
}

pub(super) fn append_created_unpublished(
    db: &Connection,
    clock: &dyn AppIdentityClock,
    project: &AppProjectSummary,
) -> Result<crate::gateway::AppEventEnvelope, AppStorageError> {
    let payload = json!({"project":project})
        .as_object()
        .cloned()
        .expect("project event object");
    events::append_unpublished(db, "project.created", None, payload, &clock.now_iso())
}

fn append_created(
    db: &Connection,
    subscribers: &EventSubscribers,
    clock: &dyn AppIdentityClock,
    project: &AppProjectSummary,
) -> Result<(), AppStorageError> {
    let payload = json!({"project":project})
        .as_object()
        .cloned()
        .expect("project event object");
    events::append(
        db,
        subscribers,
        "project.created",
        None,
        payload,
        &clock.now_iso(),
    )?;
    Ok(())
}

pub(super) fn summary(
    row: ProjectRow,
    sessions: Option<Vec<AppSessionSummary>>,
) -> AppProjectSummary {
    let active = sessions.as_ref().map(|sessions| {
        sessions
            .iter()
            .filter(|session| !session.archived)
            .collect::<Vec<_>>()
    });
    let last_activity_at = active
        .as_ref()
        .and_then(|sessions| {
            sessions
                .iter()
                .map(|session| session.last_activity_at.as_str())
                .max()
                .map(str::to_owned)
        })
        .unwrap_or_else(|| row.updated_at.clone());
    AppProjectSummary {
        id: row.id,
        display_name: row.display_name,
        status: row.status,
        last_activity_at,
        active_session_count: active.as_ref().map_or(0, Vec::len),
        pinned: row.pinned,
        archived: row.archived,
        error_summary: row.error_summary,
        workspace_label: row.workspace_label,
        safe_path_label: row.safe_path_label,
        sessions,
    }
}

pub(super) fn id(row: &ProjectRow) -> &str {
    &row.id
}

fn next_id(
    db: &Connection,
    clock: &dyn AppIdentityClock,
    name: &str,
) -> Result<String, AppStorageError> {
    let safe = safe_local_id(name);
    for _ in 0..16 {
        let uuid = clock.new_uuid();
        let candidate = format!("project-{safe}-{}", &uuid[..uuid.len().min(8)]);
        if active_by_id(db, &candidate)?.is_none() {
            return Ok(candidate);
        }
    }
    Ok(format!("project-{}", clock.new_uuid()))
}

fn safe_local_id(value: &str) -> String {
    let mut output = String::new();
    let mut invalid_run = false;
    for character in trim_js_whitespace(value).to_lowercase().chars() {
        if character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '.' | '_' | '-')
        {
            output.push(character);
            invalid_run = false;
        } else if !invalid_run {
            output.push('-');
            invalid_run = true;
        }
    }
    if output.is_empty() {
        "session".to_owned()
    } else {
        output
    }
}

fn safe_ledger_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 120
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn clip_utf16(value: &str, max: usize) -> String {
    let mut size = 0;
    value
        .chars()
        .take_while(|character| {
            size += character.len_utf16();
            size <= max
        })
        .collect()
}
