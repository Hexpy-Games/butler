//! Complete context inputs from the caller's existing read snapshot.
use super::super::{
    AppSettingsFacts, EventSubscribers, read_model, settings, storage::AppStorageError,
};
use crate::gateway::application::storage::CachedSql;
use crate::gateway::{MessageRecord, SessionArtifactSummary, TurnRecord};
use rusqlite::Connection;

pub(in crate::gateway::application) struct Records {
    pub messages: Vec<MessageRecord>,
    pub latest_turn: Option<TurnRecord>,
    pub artifacts: Vec<SessionArtifactSummary>,
    pub controls: settings::SessionWorkspaceSettings,
    pub turn_count: u64,
    pub file_count: u64,
}
pub(in crate::gateway::application) struct ViewFacts {
    pub messages: Vec<MessageRecord>,
    pub latest_turn: Option<TurnRecord>,
    pub artifacts: Vec<SessionArtifactSummary>,
}
pub(in crate::gateway::application) fn read(
    db: &Connection,
    session: &str,
    facts: &AppSettingsFacts,
    subscribers: &EventSubscribers,
    now: &str,
) -> Result<Records, AppStorageError> {
    let view = ViewFacts {
        messages: read_model::list_message_page(db, session, None, None, 16)?
            .view
            .messages,
        latest_turn: read_model::latest_turn(db, session)?,
        artifacts: read_model::list_artifacts(db, session)?,
    };
    read_metadata(db, session, facts, subscribers, now, view)
}

pub(in crate::gateway::application) fn read_metadata(
    db: &Connection,
    session: &str,
    facts: &AppSettingsFacts,
    subscribers: &EventSubscribers,
    now: &str,
    view: ViewFacts,
) -> Result<Records, AppStorageError> {
    Ok(Records {
        messages: view.messages,
        latest_turn: view.latest_turn,
        artifacts: view.artifacts,
        controls: settings::session_context_settings(db, subscribers, facts, session, now)?,
        turn_count: db
            .query_row_cached(
                "SELECT COUNT(*) FROM turns WHERE chat_id=?1",
                [session],
                |row| row.get(0),
            )
            .map_err(AppStorageError::sqlite)?,
        file_count: db
            .query_row_cached(
                "SELECT COUNT(*) FROM message_files WHERE owner_session_id=?1",
                [session],
                |row| row.get(0),
            )
            .map_err(AppStorageError::sqlite)?,
    })
}
