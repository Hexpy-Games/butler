//! Exact published-artifact reads and explicit copy-through attachment.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};
use super::contracts::{
    AppProjectDashboardPageQuery, invalid_cursor, invalid_request, source_changed,
};
use super::cursor::{self, ArtifactCursor};
use super::project::read_project;
use crate::gateway::{AppFileUpload, MessageFileRef};
use crate::public_text::sanitize_public_text;

pub(super) async fn get(
    application: &AppApplication,
    project_id: &str,
    query: AppProjectDashboardPageQuery,
) -> Result<Value, GatewayApplicationError> {
    if !(1..=100).contains(&query.limit) {
        return Err(invalid_request());
    }
    let _project = read_project(application, project_id).await?;
    let cursor = query
        .cursor
        .as_deref()
        .map(cursor::decode::<ArtifactCursor>)
        .transpose()?;
    if cursor
        .as_ref()
        .is_some_and(|cursor| cursor.project_id != project_id || cursor.rowid == 0)
    {
        return Err(invalid_cursor());
    }
    let project_key = project_id.to_owned();
    let before_rowid = cursor
        .as_ref()
        .map_or(i64::MAX, |cursor| cursor.rowid as i64);
    let before_file = cursor
        .as_ref()
        .map_or_else(String::new, |cursor| cursor.file_id.clone());
    let limit = query.limit;
    let rows = application
        .storage
        .execute(move |db| read_artifact_page(db, &project_key, before_rowid, &before_file, limit))
        .await
        .map_err(app_error)?;
    let selected = rows.iter().take(query.limit).collect::<Vec<_>>();
    let next_cursor = (rows.len() > query.limit)
        .then(|| {
            selected.last().and_then(|row| {
                cursor::encode(&ArtifactCursor {
                    project_id: project_id.to_owned(),
                    rowid: row.message_rowid,
                    file_id: row.file.id.clone(),
                })
                .ok()
            })
        })
        .flatten();
    let items = selected
        .iter()
        .map(|row| artifact_summary(row, project_id))
        .collect::<Result<Vec<_>, _>>()
        .map_err(app_error)?;
    Ok(json!({
        "items":items,
        "nextCursor":next_cursor,
    }))
}

pub(super) async fn attach(
    application: &AppApplication,
    project_id: &str,
    artifact_id: &str,
    revision: &str,
) -> Result<MessageFileRef, GatewayApplicationError> {
    let id = artifact_id.to_owned();
    let project_key = project_id.to_owned();
    let artifact = application
        .storage
        .execute(move |db| read_artifact(db, &project_key, &id))
        .await
        .map_err(app_error)?
        .ok_or_else(source_unavailable)?;
    if artifact.revision != revision {
        return Err(source_changed("Source changed. Reload it."));
    }
    let original = application
        .download_message_file(artifact.file.file_id.clone())
        .await?;
    if original.bytes.len() as u64 != original.file.size_bytes
        || digest(&original.bytes) != revision
    {
        return Err(source_changed("Source changed. Reload it."));
    }
    application
        .upload_message_file(AppFileUpload {
            owner_session_id: None,
            name: original.file.safe_name,
            mime_type: Some(original.file.mime_type),
            bytes: original.bytes,
        })
        .await
}

struct ArtifactRow {
    message_rowid: u64,
    message_id: String,
    session_id: String,
    turn_id: Option<String>,
    session_title: String,
    file: crate::gateway::application::AppMessageFileSnapshot,
}

fn read_artifact_page(
    db: &Connection,
    project_id: &str,
    before_rowid: i64,
    before_file: &str,
    limit: usize,
) -> Result<Vec<ArtifactRow>, AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT m.rowid,m.id,m.chat_id,m.turn_id,c.title,f.id,f.kind,f.mime_type,\
             f.safe_name,f.size_bytes,f.sha256,f.storage_name,f.created_at \
             FROM chats c JOIN messages m ON m.chat_id=c.id \
             JOIN message_attachments a ON a.message_id=m.id \
             JOIN message_files f ON f.id=a.file_id WHERE c.project_id=?1 \
             AND m.role='assistant' AND m.status='delivered' AND \
             NOT (m.safe_error_code IS NOT NULL AND m.safe_error_code IN \
             ('app_turn_queue_failed','goal_completion_incomplete')) \
             AND (m.rowid<?2 OR (m.rowid=?2 AND f.id<?3)) \
             ORDER BY m.rowid DESC,f.id DESC LIMIT ?4",
        )
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map(
            params![project_id, before_rowid, before_file, limit + 1],
            |row| {
                let file = crate::gateway::application::AppMessageFileSnapshot {
                    id: row.get(5)?,
                    owner_session_id: None,
                    message_id: None,
                    kind: row.get(6)?,
                    mime_type: row.get(7)?,
                    safe_name: row.get(8)?,
                    size_bytes: row.get(9)?,
                    sha256: row.get(10)?,
                    storage_name: row.get(11)?,
                    created_at: row.get(12)?,
                };
                Ok(ArtifactRow {
                    message_rowid: row.get::<_, i64>(0)?.max(0) as u64,
                    message_id: row.get(1)?,
                    session_id: row.get(2)?,
                    turn_id: row.get(3)?,
                    session_title: row.get(4)?,
                    file,
                })
            },
        )
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

fn artifact_summary(row: &ArtifactRow, project_id: &str) -> Result<Value, AppStorageError> {
    let file = super::super::super::read_model::message_file_ref(&row.file)?;
    let id = format!("artifact-{}", file.file_id);
    Ok(artifact_value(ArtifactValueInput {
        file: &file,
        id: &id,
        session_id: &row.session_id,
        project_id,
        message_id: &row.message_id,
        turn_id: row.turn_id.as_deref(),
        session_title: &row.session_title,
        revision: &file.sha256,
    }))
}

#[derive(Clone, Copy)]
struct ArtifactValueInput<'a> {
    file: &'a MessageFileRef,
    id: &'a str,
    session_id: &'a str,
    project_id: &'a str,
    message_id: &'a str,
    turn_id: Option<&'a str>,
    session_title: &'a str,
    revision: &'a str,
}

fn artifact_value(input: ArtifactValueInput<'_>) -> Value {
    let ArtifactValueInput {
        file,
        id,
        session_id,
        project_id,
        message_id,
        turn_id,
        session_title,
        revision,
    } = input;
    json!({
        "id":id,
        "session_id":session_id,
        "project_id":project_id,
        "message_id":message_id,
        "turn_id":turn_id,
        "file_id":file.file_id,
        "kind":artifact_kind(file),
        "title":sanitize_public_text(&file.safe_name, ""),
        "safe_path_label":sanitize_public_text(&file.safe_name, ""),
        "url":file.url,
        "size_bytes":file.size_bytes,
        "created_at":file.created_at,
        "open_action":"route",
        "session_title":sanitize_public_text(session_title, ""),
        "revision":revision,
        "mime_type":file.mime_type,
    })
}

fn artifact_kind(file: &MessageFileRef) -> &'static str {
    let name = file.safe_name.to_ascii_lowercase();
    let mime = file.mime_type.to_ascii_lowercase();
    if matches!(file.kind, crate::gateway::MessageFileKind::Image) {
        "image"
    } else if mime == "text/csv" || name.ends_with(".csv") {
        "csv_file"
    } else if mime == "text/tab-separated-values" || name.ends_with(".tsv") {
        "table_file"
    } else if mime == "application/pdf" {
        "report"
    } else if matches!(file.kind, crate::gateway::MessageFileKind::Text) {
        "document"
    } else if [
        ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt",
    ]
    .iter()
    .any(|extension| name.ends_with(extension))
    {
        "code"
    } else {
        "file"
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) struct DashboardArtifact {
    pub id: String,
    pub file: MessageFileRef,
    pub session_id: String,
    pub message_id: String,
    pub turn_id: Option<String>,
    pub session_title: String,
    pub project_id: String,
    pub revision: String,
}

pub(super) fn artifact_json(artifact: &DashboardArtifact) -> Value {
    artifact_value(ArtifactValueInput {
        file: &artifact.file,
        id: &artifact.id,
        session_id: &artifact.session_id,
        project_id: &artifact.project_id,
        message_id: &artifact.message_id,
        turn_id: artifact.turn_id.as_deref(),
        session_title: &artifact.session_title,
        revision: &artifact.revision,
    })
}

pub(super) fn read_artifact(
    db: &Connection,
    project_id: &str,
    artifact_id: &str,
) -> Result<Option<DashboardArtifact>, AppStorageError> {
    let Some(file_id) = artifact_id.strip_prefix("artifact-") else {
        return Ok(None);
    };
    let row = db
        .query_row(
            "SELECT m.id,m.chat_id,m.turn_id,c.title, f.id,f.kind,f.mime_type,\
             f.safe_name,f.size_bytes,f.sha256,f.storage_name,f.created_at FROM chats c \
             JOIN messages m ON m.chat_id=c.id JOIN message_attachments a ON a.message_id=m.id \
             JOIN message_files f ON f.id=a.file_id WHERE c.project_id=?1 AND f.id=?2 \
             AND m.role='assistant' AND m.status='delivered' AND \
             NOT (m.safe_error_code IS NOT NULL AND m.safe_error_code IN \
             ('app_turn_queue_failed','goal_completion_incomplete')) \
             ORDER BY m.rowid DESC LIMIT 1",
            params![project_id, file_id],
            |row| {
                let file_id: String = row.get(4)?;
                let kind: String = row.get(5)?;
                let mime_type: String = row.get(6)?;
                let safe_name: String = row.get(7)?;
                let size_bytes: u64 = row.get(8)?;
                let sha256: String = row.get(9)?;
                let storage_name: String = row.get(10)?;
                let created_at: String = row.get(11)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    crate::gateway::application::AppMessageFileSnapshot {
                        id: file_id,
                        owner_session_id: None,
                        message_id: None,
                        kind,
                        mime_type,
                        safe_name,
                        size_bytes,
                        sha256: sha256.clone(),
                        storage_name,
                        created_at,
                    },
                    sha256,
                ))
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let Some((message_id, session_id, turn_id, session_title, file_row, revision)) = row else {
        return Ok(None);
    };
    let file = super::super::super::read_model::message_file_ref(&file_row)?;
    Ok(Some(DashboardArtifact {
        id: format!("artifact-{}", file.file_id),
        file,
        session_id,
        message_id,
        turn_id,
        session_title: sanitize_public_text(&session_title, ""),
        project_id: project_id.to_owned(),
        revision,
    }))
}

fn source_unavailable() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 404,
        code: "source_unavailable".into(),
        message: "Source unavailable.".into(),
    }
}
