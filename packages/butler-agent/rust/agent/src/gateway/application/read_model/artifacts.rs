use rusqlite::Connection;

use super::super::storage::AppStorageError;
use super::{MessageFileRef, MessageRow, file_ref_from_values, require_chat};
use crate::gateway::{ArtifactKind, ArtifactOpenAction, SessionArtifactSummary};

pub(super) fn list(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<SessionArtifactSummary>, AppStorageError> {
    require_chat(connection, session_id)?;
    let mut statement = connection
        .prepare(
            "WITH latest_messages AS ( \
               SELECT rowid AS message_rowid,id,chat_id,turn_id,role,safe_error_code \
               FROM messages \
               WHERE chat_id=?1 \
                 AND NOT (role='assistant' AND safe_error_code IS NOT NULL AND \
                   safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete')) \
               ORDER BY rowid DESC LIMIT 200 \
             ) \
             SELECT m.message_rowid,m.id,m.chat_id,m.turn_id, \
                    f.id,f.kind,f.mime_type,f.safe_name,f.size_bytes,f.sha256,f.created_at \
             FROM latest_messages AS m \
             JOIN message_attachments AS a ON a.message_id=m.id \
             JOIN message_files AS f ON f.id=a.file_id \
             WHERE m.role='assistant' \
             ORDER BY m.message_rowid DESC,a.position DESC \
             LIMIT 20",
        )
        .map_err(AppStorageError::sqlite)?;
    let mut artifacts = statement
        .query_map([session_id], |row| {
            let message_rowid: u64 = row.get(0)?;
            let message_id: String = row.get(1)?;
            let chat_id: String = row.get(2)?;
            let turn_id: Option<String> = row.get(3)?;
            let file = file_ref_from_values(
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
            )?;
            Ok((message_rowid, message_id, chat_id, turn_id, file))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    artifacts.reverse();
    Ok(artifacts
        .into_iter()
        .map(|(_, message_id, chat_id, turn_id, file)| {
            artifact_summary(&chat_id, &message_id, turn_id.as_deref(), &file)
        })
        .collect())
}

pub(super) fn artifact(row: &MessageRow, file: &MessageFileRef) -> SessionArtifactSummary {
    artifact_summary(&row.chat_id, &row.id, row.turn_id.as_deref(), file)
}

fn artifact_summary(
    chat_id: &str,
    message_id: &str,
    turn_id: Option<&str>,
    file: &MessageFileRef,
) -> SessionArtifactSummary {
    SessionArtifactSummary {
        id: format!("artifact-{}", file.file_id),
        session_id: Some(chat_id.to_owned()),
        project_id: None,
        message_id: Some(message_id.to_owned()),
        turn_id: turn_id.map(str::to_owned),
        file_id: Some(file.file_id.clone()),
        kind: artifact_kind(file),
        title: file.safe_name.clone(),
        safe_path_label: Some(file.safe_name.clone()),
        url: Some(file.url.clone()),
        size_bytes: Some(file.size_bytes),
        created_at: file.created_at.clone(),
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
