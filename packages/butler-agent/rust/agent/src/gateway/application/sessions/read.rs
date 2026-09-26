use rusqlite::{Connection, OptionalExtension, Row, params_from_iter};
use serde_json::Value;

use super::{AppStorageError, contracts::*, json_error};
use crate::public_text::trim_js_whitespace;

pub(super) struct WorkspaceProject {
    pub id: String,
    pub display_name: String,
    pub workspace_path: String,
    pub ledger_project_id: Option<String>,
}

pub(super) fn workspace_project(
    db: &Connection,
    project_id: &str,
) -> Result<WorkspaceProject, AppStorageError> {
    db.query_row(
        "SELECT id,display_name,workspace_path,ledger_project_id FROM projects WHERE id=?1",
        [project_id],
        |row| {
            Ok(WorkspaceProject {
                id: row.get(0)?,
                display_name: row.get(1)?,
                workspace_path: row.get(2)?,
                ledger_project_id: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(AppStorageError::sqlite)?
    .ok_or_else(|| {
        AppStorageError::new(
            "session_worktree_creation_failed",
            "Project session worktree could not be created.",
        )
    })
}

const SESSION_SELECT: &str = r"
SELECT c.id,c.kind,c.title,c.project_id,c.created_at,c.updated_at,
 (SELECT m.text FROM messages m WHERE m.chat_id=c.id
   AND NOT(m.role='assistant' AND m.safe_error_code IS NOT NULL
     AND m.safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete'))
   ORDER BY m.rowid DESC LIMIT 1) AS last_message_preview,
 (SELECT t.state FROM turns t WHERE t.chat_id=c.id ORDER BY t.rowid DESC LIMIT 1) AS active_turn_state,
 (SELECT t.safe_status_label FROM turns t WHERE t.chat_id=c.id ORDER BY t.rowid DESC LIMIT 1) AS safe_status_label,
 (SELECT t.safe_status_label_parameters_json FROM turns t WHERE t.chat_id=c.id ORDER BY t.rowid DESC LIMIT 1) AS safe_status_label_parameters_json,
 (SELECT t.safe_status_content_json FROM turns t WHERE t.chat_id=c.id ORDER BY t.rowid DESC LIMIT 1) AS safe_status_content_json,
 (SELECT t.safe_error_code FROM turns t WHERE t.chat_id=c.id ORDER BY t.rowid DESC LIMIT 1) AS active_turn_safe_error_code,
 (SELECT t.id FROM turns t WHERE t.chat_id=c.id ORDER BY t.rowid DESC LIMIT 1) AS latest_turn_id,
 c.pinned,c.archived,
 (SELECT COUNT(*) FROM app_automations a WHERE a.target_session_id=c.id AND a.state!='deleted'),
 (SELECT display_name FROM projects p WHERE p.id=c.project_id) AS project_display_name
FROM chats c
";

struct SessionRow {
    id: String,
    kind: String,
    title: String,
    project_id: Option<String>,
    created_at: String,
    updated_at: String,
    preview: Option<String>,
    state: Option<String>,
    label: Option<String>,
    parameters: Option<String>,
    content: Option<String>,
    safe_error: Option<String>,
    latest_turn_id: Option<String>,
    pinned: i64,
    archived: i64,
    automation_target_count: i64,
    project_display_name: Option<String>,
}

fn session_row(row: &Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        project_id: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        preview: row.get(6)?,
        state: row.get(7)?,
        label: row.get(8)?,
        parameters: row.get(9)?,
        content: row.get(10)?,
        safe_error: row.get(11)?,
        latest_turn_id: row.get(12)?,
        pinned: row.get(13)?,
        archived: row.get(14)?,
        automation_target_count: row.get(15)?,
        project_display_name: row.get(16)?,
    })
}

pub(super) fn session(db: &Connection, id: &str) -> Result<AppSessionSummary, AppStorageError> {
    let sql = format!("{SESSION_SELECT} WHERE c.id=?1");
    let row = db
        .query_row(&sql, [id], session_row)
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(|| AppStorageError::new("session_not_found", "Session not found."))?;
    let mut summary = project(row)?;
    let seed: Option<String> = db.query_row(
        "SELECT seed_json FROM app_session_branches WHERE target_session_id=?1 AND state='ready'",
        [id], |row| row.get(0),
    ).optional().map_err(AppStorageError::sqlite)?;
    summary.branch_seed = seed
        .map(|raw| serde_json::from_str(&raw).map_err(json_error))
        .transpose()?;
    Ok(summary)
}

pub(super) fn chats(db: &mut Connection) -> Result<Vec<AppChatSummary>, AppStorageError> {
    let mut statement = db
        .prepare(
            r"
SELECT id,title,kind,project_id,created_at,updated_at FROM chats
WHERE archived=0 AND NOT EXISTS(
  SELECT 1 FROM app_session_branches b
  WHERE b.target_session_id=chats.id AND b.state='prepared')
ORDER BY updated_at DESC,created_at DESC
",
        )
        .map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(AppStorageError::sqlite)?;
    rows.map(|row| {
        let (id, title, kind, project_id, created_at, updated_at) =
            row.map_err(AppStorageError::sqlite)?;
        Ok(AppChatSummary {
            id,
            title,
            kind: chat_kind(&kind)?,
            project_id,
            created_at,
            updated_at,
        })
    })
    .collect()
}

pub(super) fn sessions(
    db: &mut Connection,
    kind: Option<&str>,
    project_id: Option<&str>,
) -> Result<Vec<AppSessionSummary>, AppStorageError> {
    let mut sql = format!(
        "{SESSION_SELECT} WHERE c.archived=0 AND NOT EXISTS(\
      SELECT 1 FROM app_session_branches b WHERE b.target_session_id=c.id AND b.state='prepared')"
    );
    let mut params = Vec::new();
    if let Some(kind) = kind.filter(|value| !value.is_empty()) {
        sql.push_str(" AND c.kind=?");
        params.push(kind);
    }
    if let Some(project_id) = project_id.filter(|value| !value.is_empty()) {
        sql.push_str(" AND c.project_id=?");
        params.push(project_id);
    }
    sql.push_str(" ORDER BY c.pinned DESC,c.updated_at DESC,c.created_at DESC");
    let mut statement = db.prepare(&sql).map_err(AppStorageError::sqlite)?;
    statement
        .query_map(params_from_iter(params), session_row)
        .map_err(AppStorageError::sqlite)?
        .map(|row| project(row.map_err(AppStorageError::sqlite)?))
        .collect()
}

pub(super) fn archives(
    db: &mut Connection,
) -> Result<Vec<(String, AppSessionSummary)>, AppStorageError> {
    let sql = format!(
        "{SESSION_SELECT} WHERE c.archived=1 AND NOT EXISTS(\
         SELECT 1 FROM app_session_branches b WHERE b.target_session_id=c.id AND b.state='prepared')\
         ORDER BY c.updated_at DESC,c.created_at DESC"
    );
    let mut statement = db.prepare(&sql).map_err(AppStorageError::sqlite)?;
    statement
        .query_map([], session_row)
        .map_err(AppStorageError::sqlite)?
        .map(|row| {
            let row = row.map_err(AppStorageError::sqlite)?;
            let key = format!("{}:{}", row.updated_at, row.created_at);
            Ok((key, project(row)?))
        })
        .collect()
}

fn project(row: SessionRow) -> Result<AppSessionSummary, AppStorageError> {
    let label = row
        .label
        .as_deref()
        .map(trim_js_whitespace)
        .filter(|text| !text.is_empty())
        .filter(|_| !matches!(row.state.as_deref(), Some("retrying" | "waiting_for_tool")))
        .filter(|_| {
            !matches!(
                row.safe_error.as_deref(),
                Some(
                    "internal_recovery_required"
                        | "goal_completion_incomplete"
                        | "app_turn_queue_failed"
                        | "completion_review_incomplete"
                )
            )
        });
    let parameters = label
        .and(row.parameters.as_deref())
        .filter(|encoded| !encoded.is_empty())
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(json_error)?;
    let content = label
        .and(row.content.as_deref())
        .filter(|encoded| !encoded.is_empty())
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(json_error)?;
    let preview = row
        .preview
        .as_deref()
        .map(trim_js_whitespace)
        .filter(|text| !text.is_empty())
        .map(|text| {
            if text.encode_utf16().count() > 96 {
                format!(
                    "{}...",
                    crate::json::Utf16Slice::new(text, 0, 93).utf8_lossy()
                )
            } else {
                text.to_owned()
            }
        });
    let project_id = row.project_id.clone();
    let project = project_id
        .clone()
        .zip(row.project_display_name)
        .map(|(id, display_name)| super::contracts::AppSessionProject { id, display_name });
    Ok(AppSessionSummary {
        latest_turn_id: row.latest_turn_id,
        skills_used: Vec::new(),
        work_progress: None,
        branch_seed: None,
        id: row.id.clone(),
        kind: chat_kind(&row.kind)?,
        title: row.title,
        project_id,
        project,
        session_hint: super::super::native_preparation::session_hint(&row.id),
        created_at: row.created_at,
        updated_at: row.updated_at.clone(),
        last_activity_at: row.updated_at,
        last_message_preview: preview,
        active_turn_state: row.state,
        safe_status_label: label.map(str::to_owned),
        safe_status_label_key: None,
        safe_status_label_parameters: parameters,
        safe_status_content: content,
        unread_count: 0,
        pinned: row.pinned == 1,
        archived: row.archived == 1,
        automation_target_count: row.automation_target_count.max(0) as u64,
    })
}

fn chat_kind(value: &str) -> Result<AppChatKind, AppStorageError> {
    match value {
        "chat" => Ok(AppChatKind::Chat),
        "project" => Ok(AppChatKind::Project),
        _ => Err(AppStorageError::new(
            "app_session_kind_invalid",
            "Invalid stored session kind",
        )),
    }
}
