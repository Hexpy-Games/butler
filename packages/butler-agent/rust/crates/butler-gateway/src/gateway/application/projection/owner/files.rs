//! Source-shaped transcript filename admission for the projection watcher.

use rusqlite::OptionalExtension;

use super::super::{sync_chat_once, sync_deferred_once};
use super::ProjectionContext;
use crate::gateway::GatewayApplicationError;

/// Transcript files of chats that may still be waiting on projection: those
/// with an open turn or a staged outbound.
pub(super) async fn open_turn_transcripts(
    context: &ProjectionContext,
) -> Result<Vec<String>, GatewayApplicationError> {
    let chats = context
        .storage
        .inspect(|db| {
            let mut statement = db
                .prepare(
                    "SELECT COALESCE(c.runtime_session_hint,'butler/app-'||c.id) FROM chats c WHERE c.id IN (SELECT chat_id FROM turns WHERE state IN (\
                     'queued','accepted','thinking','streaming','waiting_for_form',\
                     'waiting_for_tool','cancelling','retrying') \
                     UNION SELECT chat_id FROM app_transport_projection_staged_outbounds)",
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
        .map(|hint| transcript_file(&hint))
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
        .inspect(move |db| {
            db.query_row("SELECT id FROM chats WHERE runtime_session_hint='butler/app-'||?1 UNION ALL SELECT id FROM chats WHERE runtime_session_hint IS NULL AND id=?1 LIMIT 1", [&candidate], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(super::super::super::storage::AppStorageError::sqlite)
        })
        .await
        .map_err(super::super::super::app_error)?;
    Ok(chat)
}

fn transcript_file(chat: &str) -> String {
    let session = chat;
    format!(
        "{}.jsonl",
        session.replace(
            |ch: char| !ch.is_ascii_alphanumeric() && !"._-".contains(ch),
            "_"
        )
    )
}

async fn sync_chat(context: &ProjectionContext, chat: &str) -> Result<(), GatewayApplicationError> {
    while sync_chat_once(context, chat).await? {
        context.streaming.flush_due(context).await?;
    }
    Ok(())
}

pub(super) async fn sync_requested(
    context: &ProjectionContext,
    chat: &str,
) -> Result<(), GatewayApplicationError> {
    sync_chat(context, chat).await?;
    while sync_deferred_once(context).await? {}
    context.streaming.flush_all(context).await
}

pub(super) async fn drain_open_turns(
    context: &ProjectionContext,
) -> Result<(), GatewayApplicationError> {
    // Existing checkpoints read only appended bytes, never whole transcripts.
    for file in open_turn_transcripts(context).await? {
        if let Some(chat) = resolve_chat_file(context, &file).await? {
            sync_chat(context, &chat).await?;
        }
    }
    while sync_deferred_once(context).await? {}
    context.streaming.flush_all(context).await
}
