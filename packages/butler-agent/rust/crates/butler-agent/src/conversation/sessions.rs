use rusqlite::{OptionalExtension, params};

use super::codec::bump_public_revision;
use super::types::*;
use super::{AgentConversationStore, ConversationError, ConversationResult};
use crate::conversation::ConversationCode;

impl AgentConversationStore {
    pub(crate) async fn sync_session_context(
        &self,
        session_id: &str,
        project_id: Option<String>,
        revision: &str,
    ) -> ConversationResult<()> {
        let session_id = session_id.to_owned();
        let revision = revision.to_owned();
        let clock = self.identity_clock().clone();
        self.execute(move |connection| {
            let tx = connection.transaction().map_err(ConversationError::sqlite)?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS conversation_session_context (\
                 session_id TEXT PRIMARY KEY REFERENCES conversation_sessions(id) ON DELETE CASCADE,\
                 revision TEXT NOT NULL)",
            )
            .map_err(ConversationError::sqlite)?;
            let previous = tx
                .query_row(
                    "SELECT project_id FROM conversation_sessions WHERE id=?1",
                    [&session_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(ConversationError::sqlite)?
                .ok_or_else(|| {
                    ConversationError::new(
                        ConversationCode::ConversationSessionNotFound,
                        "conversation_session_not_found",
                    )
                })?;
            let current = tx
                .query_row(
                    "SELECT revision FROM conversation_session_context WHERE session_id=?1",
                    [&session_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(ConversationError::sqlite)?;
            if current.as_deref() == Some(&revision) {
                tx.commit().map_err(ConversationError::sqlite)?;
                return Ok(());
            }
            tx.execute(
                "UPDATE conversation_sessions SET project_id=?1,workspace_id=NULL,updated_at=?2 \
                 WHERE id=?3",
                params![project_id, clock.now_iso(), session_id],
            )
            .map_err(ConversationError::sqlite)?;
            tx.execute(
                "INSERT INTO conversation_session_context VALUES(?1,?2) \
                 ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision",
                params![session_id, revision],
            )
            .map_err(ConversationError::sqlite)?;
            if previous != project_id {
                bump_public_revision(&tx)?;
            }
            tx.commit().map_err(ConversationError::sqlite)
        })
        .await
    }

    pub(crate) async fn get_session(
        &self,
        session_id: &str,
    ) -> ConversationResult<Option<ConversationSession>> {
        let session_id = session_id.to_owned();
        self.execute(move |connection| {
            connection
                .query_row(
                    "SELECT * FROM conversation_sessions WHERE id=?1 LIMIT 1",
                    [session_id],
                    session_row,
                )
                .optional()
                .map_err(ConversationError::sqlite)
        })
        .await
    }

    pub(crate) async fn get_session_by_gateway_binding(
        &self,
        gateway: &str,
        external_session_id: &str,
    ) -> ConversationResult<Option<ConversationSession>> {
        let gateway = gateway.to_owned();
        let external_session_id = external_session_id.to_owned();
        self.execute(move |connection| {
            connection
                .query_row(
                    "SELECT s.* FROM conversation_sessions s JOIN conversation_bindings b \
                     ON b.conversation_session_id=s.id WHERE b.gateway=?1 \
                     AND b.external_session_id=?2 LIMIT 1",
                    params![gateway, external_session_id],
                    session_row,
                )
                .optional()
                .map_err(ConversationError::sqlite)
        })
        .await
    }

    pub(crate) async fn get_gateway_binding_for_conversation(
        &self,
        session_id: &str,
        gateway: &str,
    ) -> ConversationResult<Option<ConversationBinding>> {
        let session_id = session_id.to_owned();
        let gateway = gateway.to_owned();
        self.execute(move |connection| {
            connection
                .query_row(
                    "SELECT gateway,external_session_id,conversation_session_id,created_at \
                     FROM conversation_bindings WHERE conversation_session_id=?1 \
                     AND gateway=?2 LIMIT 1",
                    params![session_id, gateway],
                    |row| {
                        Ok(ConversationBinding {
                            gateway: row.get(0)?,
                            external_session_id: row.get(1)?,
                            conversation_session_id: row.get(2)?,
                            created_at: row.get(3)?,
                        })
                    },
                )
                .optional()
                .map_err(ConversationError::sqlite)
        })
        .await
    }
}

pub(super) fn session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationSession> {
    Ok(ConversationSession {
        id: row.get("id")?,
        workspace_id: row.get("workspace_id")?,
        project_id: row.get("project_id")?,
        gateway_origin: row.get("gateway_origin")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        status: row.get("status")?,
        schema_version: row.get("schema_version")?,
    })
}
