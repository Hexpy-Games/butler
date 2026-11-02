use rusqlite::Connection;
use std::collections::HashSet;

use super::super::storage::AppStorageError;
use super::{MessageFileRef, MessageRow, file_ref_from_values, require_chat};
use crate::gateway::{ArtifactKind, ArtifactOpenAction, SessionArtifactSummary};

pub(super) fn list(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<SessionArtifactSummary>, AppStorageError> {
    require_chat(connection, session_id)?;
    let mut statement = connection
        .prepare_cached(
            "WITH latest_messages AS ( \
               SELECT rowid AS message_rowid,id,chat_id,turn_id,role,safe_error_code,updated_at \
               FROM app_owned_messages \
               WHERE chat_id=?1 \
                 AND NOT (role='assistant' AND safe_error_code IS NOT NULL AND \
                   safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete')) \
               ORDER BY rowid DESC LIMIT 200 \
             ) \
             SELECT m.message_rowid,m.id,m.chat_id,m.turn_id, \
                    f.id,f.kind,f.mime_type,f.safe_name,f.size_bytes,f.sha256,f.created_at,f.source_label,f.deliverable,f.title,f.width,f.height,m.updated_at \
             FROM latest_messages AS m \
             JOIN message_attachments AS a ON a.message_id=m.id \
             JOIN message_files AS f ON f.id=a.file_id \
             WHERE m.role='assistant' AND f.deliverable=1 \
             ORDER BY m.updated_at DESC,m.message_rowid DESC,a.position DESC",
        )
        .map_err(AppStorageError::sqlite)?;
    let mut artifacts = statement
        .query_map([session_id], |row| {
            let message_rowid: u64 = row.get(0)?;
            let message_id: String = row.get(1)?;
            let chat_id: String = row.get(2)?;
            let turn_id: Option<String> = row.get(3)?;
            let file = delivery_file(row)?;
            Ok((
                message_rowid,
                message_id,
                chat_id,
                turn_id,
                file,
                row.get::<_, String>(16)?,
            ))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let mut seen = HashSet::new();
    artifacts.retain(|(_, _, _, _, file, _)| {
        seen.insert((
            file.source_label
                .as_deref()
                .unwrap_or(&file.file_id)
                .to_owned(),
            file.sha256.clone(),
        ))
    });
    artifacts.truncate(20);
    artifacts.reverse();
    Ok(artifacts
        .into_iter()
        .map(|(_, message_id, chat_id, turn_id, file, delivered_at)| {
            artifact_summary(
                &chat_id,
                &message_id,
                turn_id.as_deref(),
                &delivered_at,
                &file,
            )
        })
        .collect())
}

fn delivery_file(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageFileRef> {
    file_ref_from_values(
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        (
            row.get(10)?,
            row.get(11)?,
            row.get(12)?,
            row.get(13)?,
            row.get(14)?,
            row.get(15)?,
        ),
    )
}

pub(super) fn artifact(row: &MessageRow, file: &MessageFileRef) -> Option<SessionArtifactSummary> {
    file.deliverable.then(|| {
        artifact_summary(
            &row.chat_id,
            &row.id,
            row.turn_id.as_deref(),
            &row.updated_at,
            file,
        )
    })
}

fn artifact_summary(
    chat_id: &str,
    message_id: &str,
    turn_id: Option<&str>,
    delivered_at: &str,
    file: &MessageFileRef,
) -> SessionArtifactSummary {
    SessionArtifactSummary {
        sha256: Some(file.sha256.clone()),
        id: format!("artifact-{}", file.file_id),
        source_label: file.source_label.clone(),
        deliverable: file.deliverable,
        session_id: Some(chat_id.to_owned()),
        project_id: None,
        message_id: Some(message_id.to_owned()),
        turn_id: turn_id.map(str::to_owned),
        file_id: Some(file.file_id.clone()),
        kind: artifact_kind(file),
        title: file.title.clone().unwrap_or_else(|| file.safe_name.clone()),
        safe_path_label: Some(file.safe_name.clone()),
        url: Some(file.url.clone()),
        size_bytes: Some(file.size_bytes),
        created_at: delivered_at.to_owned(),
        open_action: Some(ArtifactOpenAction::Route),
    }
}

fn artifact_kind(file: &MessageFileRef) -> ArtifactKind {
    const CODE_EXTENSIONS: &[&str] = &[
        ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt",
    ];
    let name = file.safe_name.to_ascii_lowercase();
    let mime = file.mime_type.to_ascii_lowercase();
    if matches!(file.kind, crate::gateway::MessageFileKind::Image) {
        ArtifactKind::Image
    } else if mime == "text/csv" || name.ends_with(".csv") {
        ArtifactKind::CsvFile
    } else if mime == "text/tab-separated-values" || name.ends_with(".tsv") {
        ArtifactKind::TableFile
    } else if mime == "application/pdf" {
        ArtifactKind::Report
    } else if matches!(file.kind, crate::gateway::MessageFileKind::Text) {
        ArtifactKind::Document
    } else if CODE_EXTENSIONS
        .iter()
        .any(|extension| name.ends_with(extension))
    {
        ArtifactKind::Code
    } else {
        ArtifactKind::File
    }
}

/// Only the requested message page: indexed document origin lookups, no library scan.
pub(super) fn documents(
    db: &Connection,
    chat: &str,
    messages: &[String],
) -> Result<std::collections::HashMap<String, Vec<SessionArtifactSummary>>, AppStorageError> {
    let mut stmt = db.prepare_cached("WITH origins AS (SELECT id AS document_id,chat_id,message_id FROM documents WHERE chat_id=?1 AND message_id IN (SELECT value FROM json_each(?2)) UNION SELECT document_id,chat_id,message_id FROM document_deliveries WHERE chat_id=?1 AND message_id IN (SELECT value FROM json_each(?2))) SELECT d.id,d.title,o.chat_id,o.message_id,d.updated_at,m.turn_id FROM origins o JOIN documents d ON d.id=o.document_id JOIN messages m ON m.id=o.message_id").map_err(AppStorageError::sqlite)?;
    let rows = stmt
        .query_map(
            rusqlite::params![chat, serde_json::json!(messages).to_string()],
            |r| {
                Ok(SessionArtifactSummary {
                    sha256: None,
                    id: r.get(0)?,
                    title: r.get(1)?,
                    session_id: r.get(2)?,
                    message_id: r.get(3)?,
                    created_at: r.get(4)?,
                    turn_id: r.get(5)?,
                    kind: ArtifactKind::Doc,
                    deliverable: true,
                    source_label: None,
                    project_id: None,
                    file_id: None,
                    safe_path_label: None,
                    url: None,
                    size_bytes: None,
                    open_action: Some(ArtifactOpenAction::Route),
                })
            },
        )
        .map_err(AppStorageError::sqlite)?;
    let mut grouped = std::collections::HashMap::<String, Vec<SessionArtifactSummary>>::new();
    for row in rows {
        let row = row.map_err(AppStorageError::sqlite)?;
        if let Some(id) = &row.message_id {
            grouped.entry(id.clone()).or_default().push(row);
        }
    }
    Ok(grouped)
}
