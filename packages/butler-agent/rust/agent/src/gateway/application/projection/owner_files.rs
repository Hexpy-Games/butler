//! Source-shaped transcript filename admission for the projection watcher.

use rusqlite::OptionalExtension;

use super::ProjectionContext;
use crate::gateway::GatewayApplicationError;

pub(super) async fn open_turn_transcripts(
    context: &ProjectionContext,
) -> Result<Vec<String>, GatewayApplicationError> {
    let chats = context
        .storage
        .execute(|db| {
            let mut statement = db
                .prepare(
                    "SELECT DISTINCT chat_id FROM turns WHERE state IN (\
                     'queued','accepted','thinking','streaming','waiting_for_form',\
                     'waiting_for_tool','cancelling','retrying')",
                )
                .map_err(super::super::super::storage::AppStorageError::sqlite)?;
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(super::super::super::storage::AppStorageError::sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(super::super::super::storage::AppStorageError::sqlite)
        })
        .await
        .map_err(super::super::super::app_error)?;
    Ok(chats
        .into_iter()
        .map(|chat| transcript_file(&chat))
        .collect())
}

pub(super) async fn resolve_chat_file(
    context: &ProjectionContext,
    file: &str,
) -> Result<Option<String>, GatewayApplicationError> {
    let Some(candidate) = file
        .strip_prefix("butler_app-")
        .and_then(|s| s.strip_suffix(".jsonl"))
    else {
        return Ok(None);
    };
    let candidate = candidate.to_owned();
    let chat = context
        .storage
        .execute(move |db| {
            db.query_row("SELECT id FROM chats WHERE id=?1", [&candidate], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(super::super::super::storage::AppStorageError::sqlite)
        })
        .await
        .map_err(super::super::super::app_error)?;
    Ok(chat.filter(|id| transcript_file(id) == file))
}

fn transcript_file(chat: &str) -> String {
    let session = super::super::super::native_preparation::session_hint(chat);
    format!(
        "{}.jsonl",
        session.replace(
            |ch: char| !ch.is_ascii_alphanumeric() && !"._-".contains(ch),
            "_"
        )
    )
}
