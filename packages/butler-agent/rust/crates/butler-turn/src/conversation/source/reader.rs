use butler_platform::sqlite;
use std::path::Path;
use std::time::Duration;

mod public_memory;
mod recall_pages;
pub use public_memory::{
    Archived, CanonicalMemoryReadBinding, MessageOrigins, PageOrder, PublicMemoryScope,
    PublicMemorySnapshot, PublicSessionRow,
};
pub use recall_pages::RecallOutcomeRow;

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use super::super::codec::read_message;
use super::super::messages::{cognition, projection};
use super::super::sessions::session_row;
use super::super::turn_outcome::read_outcome;
use super::super::turns::get_turn;
use super::super::{
    ConversationError, ConversationMessageWithParts, ConversationResult, ConversationSession,
    ConversationStatusStats, ConversationTurn, ReadCognitionMessagesInput, TurnOutcomeCapsule,
};
use crate::conversation::ConversationCode;

const REQUIRED_TABLES: [&str; 8] = [
    "conversation_sessions",
    "conversation_bindings",
    "conversation_turns",
    "conversation_messages",
    "conversation_parts",
    "conversation_turn_outcomes",
    "conversation_projection_outbox",
    "conversation_schema_migrations",
];

/// A read-only connection to the conversation store for source readers.
pub struct ConversationSourceReader {
    pub(super) connection: Option<Connection>,
}

impl ConversationSourceReader {
    /// The number of messages with source-bearing parts.
    pub fn count_source_bearing_messages(&self) -> ConversationResult<u64> {
        self.connection()?
            .query_row(
                "SELECT COUNT(DISTINCT m.id) FROM conversation_messages m \
             JOIN conversation_parts p ON p.message_id=m.id \
             WHERE p.kind IN ('text','message_content')",
                [],
                |row| row.get(0),
            )
            .map_err(ConversationError::sqlite)
    }
    /// Opens the store read-only.
    pub fn open(path: &Path) -> ConversationResult<Self> {
        let connection = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(source_open_error)?;
        connection
            .busy_timeout(Duration::from_millis(5_000))
            .map_err(ConversationError::sqlite)?;
        connection
            .pragma_update(None, "query_only", "ON")
            .map_err(ConversationError::sqlite)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(ConversationError::sqlite)?;
        validate_schema(&connection)?;
        Ok(Self {
            connection: Some(connection),
        })
    }

    /// A message by id.
    pub fn read_message(
        &self,
        id: &str,
    ) -> ConversationResult<Option<ConversationMessageWithParts>> {
        read_message(self.connection()?, id)
    }

    pub(crate) fn read_message_by_source_ref(
        &self,
        session_id: &str,
        source_ref: &str,
    ) -> ConversationResult<Option<ConversationMessageWithParts>> {
        read_by_source_ref(self.connection()?, session_id, source_ref)
    }

    pub(crate) fn read_message_by_source_ref_any_session(
        &self,
        source_ref: &str,
    ) -> ConversationResult<Option<ConversationMessageWithParts>> {
        read_by_source_ref_any_session(self.connection()?, source_ref)
    }

    /// Ids of a session's recent public messages.
    pub fn read_recent_public_message_ids(
        &self,
        session_id: &str,
    ) -> ConversationResult<Vec<String>> {
        let mut statement = self.connection()?.prepare(
            "SELECT id FROM conversation_messages WHERE session_id=?1 AND status='complete' \
             AND compacted_by_summary_id IS NULL AND origin_kind IN ('user_input','assistant_public') \
             AND role IN ('user','assistant') ORDER BY seq DESC,id DESC LIMIT 8",
        ).map_err(ConversationError::sqlite)?;
        statement
            .query_map([session_id], |row| row.get::<_, String>(0))
            .map_err(ConversationError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(ConversationError::sqlite)
    }

    /// The store's public source revision. It moves on every message, turn,
    /// outcome or session change, so an unchanged value means an unchanged
    /// inventory. A store without the counter reads as revision 0.
    pub fn public_revision(&self) -> ConversationResult<u64> {
        let connection = self.connection()?;
        let counted: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_public_source_state')",
                [],
                |row| row.get(0),
            )
            .map_err(ConversationError::sqlite)?;
        if !counted {
            return Ok(0);
        }
        super::super::codec::public_revision(connection)
    }

    /// Stable identity of this canonical store, including across appends.
    pub fn source_identity(&self) -> ConversationResult<Option<String>> {
        let connection = self.connection()?;
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_source_identity')",
            [], |row| row.get(0),
        ).map_err(ConversationError::sqlite)?;
        if !exists {
            return Ok(None);
        }
        connection
            .query_row(
                "SELECT identity FROM conversation_source_identity WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(ConversationError::sqlite)
    }

    /// Whether both saved catch-up cursors still name canonical rows.
    pub fn catchup_cursors_exist(
        &self,
        outcome: Option<&str>,
        message: Option<&str>,
    ) -> ConversationResult<bool> {
        let connection = self.connection()?;
        for (table, id) in [
            ("conversation_turn_outcomes", outcome),
            ("conversation_messages", message),
        ] {
            if let Some(id) = id {
                let exists: bool = connection
                    .query_row(
                        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1)"),
                        [id],
                        |row| row.get(0),
                    )
                    .map_err(ConversationError::sqlite)?;
                if !exists {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    /// A page of turn outcomes for recall.
    pub fn read_recall_outcome_page(
        &self,
        after_id: Option<&str>,
        limit: Option<usize>,
    ) -> ConversationResult<Vec<RecallOutcomeRow>> {
        recall_pages::outcomes(self.connection()?, after_id, limit)
    }

    /// A page of recovered source messages.
    pub fn read_recovered_source_page(
        &self,
        after_id: Option<&str>,
        limit: Option<usize>,
    ) -> ConversationResult<Vec<ConversationMessageWithParts>> {
        recall_pages::recovered(self.connection()?, after_id, limit)
    }

    /// A turn by id.
    pub fn read_turn(&self, id: &str) -> ConversationResult<Option<ConversationTurn>> {
        get_turn(self.connection()?, id)
    }

    /// A session by id.
    pub fn read_session(&self, id: &str) -> ConversationResult<Option<ConversationSession>> {
        self.connection()?
            .query_row(
                "SELECT * FROM conversation_sessions WHERE id=?1 LIMIT 1",
                [id],
                session_row,
            )
            .optional()
            .map_err(ConversationError::sqlite)
    }

    /// A session's message and summary statistics.
    pub fn read_status_context_stats(
        &self,
        session_id: &str,
        semantic_tail_limit: u64,
    ) -> ConversationResult<ConversationStatusStats> {
        super::super::summaries::read_status_context_stats(
            self.connection()?,
            session_id,
            semantic_tail_limit,
        )
    }

    /// A turn's outcome capsule.
    pub fn read_turn_outcome(
        &self,
        turn_id: &str,
    ) -> ConversationResult<Option<TurnOutcomeCapsule>> {
        read_outcome(self.connection()?, turn_id)
    }

    /// A session's projected messages (up to 500).
    pub fn read_projection_messages(
        &self,
        session_id: &str,
    ) -> ConversationResult<Vec<ConversationMessageWithParts>> {
        projection(self.connection()?, session_id, None, Some(500.0))
    }

    /// Messages for memory cognition.
    pub fn read_cognition_messages(
        &self,
        input: &ReadCognitionMessagesInput,
    ) -> ConversationResult<Vec<ConversationMessageWithParts>> {
        cognition(self.connection()?, input.clone())
    }

    /// Closes the connection.
    pub fn close(mut self) -> ConversationResult<()> {
        let Some(connection) = self.connection.take() else {
            return Ok(());
        };
        connection
            .close()
            .map_err(|(_, error)| ConversationError::sqlite(error))
    }

    fn connection(&self) -> ConversationResult<&Connection> {
        self.connection.as_ref().ok_or_else(|| {
            ConversationError::new(
                ConversationCode::ConversationSourceClosed,
                "Conversation source reader is closed",
            )
        })
    }
}

impl Drop for ConversationSourceReader {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take() {
            let _ = connection.close();
        }
    }
}

fn validate_schema(connection: &Connection) -> ConversationResult<()> {
    for table in REQUIRED_TABLES {
        let found: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |row| row.get(0),
            )
            .map_err(ConversationError::sqlite)?;
        if !found {
            return Err(ConversationError::new(
                ConversationCode::ConversationSourceSchemaUnavailable,
                format!("Canonical Conversation schema is missing table {table}"),
            ));
        }
    }
    Ok(())
}

fn source_open_error(error: rusqlite::Error) -> ConversationError {
    ConversationError::new(
        ConversationCode::ConversationSourceUnavailable,
        error.to_string(),
    )
    .with_source(error)
}

fn read_by_source_ref(
    connection: &Connection,
    session_id: &str,
    source_ref: &str,
) -> ConversationResult<Option<ConversationMessageWithParts>> {
    let source_ref = butler_core::public_text::trim_js_whitespace(source_ref);
    if source_ref.is_empty() {
        return Ok(None);
    }
    let id = connection
        .query_row(
            "SELECT id FROM conversation_messages WHERE session_id=?1 AND source_ref=?2 \
             ORDER BY seq ASC LIMIT 1",
            [session_id, source_ref],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(ConversationError::sqlite)?;
    id.map(|id| read_message(connection, &id))
        .transpose()
        .map(Option::flatten)
}

fn read_by_source_ref_any_session(
    connection: &Connection,
    source_ref: &str,
) -> ConversationResult<Option<ConversationMessageWithParts>> {
    let source_ref = butler_core::public_text::trim_js_whitespace(source_ref);
    if source_ref.is_empty() {
        return Ok(None);
    }
    let id = connection
        .query_row(
            "SELECT id FROM conversation_messages WHERE source_ref=?1 \
             ORDER BY created_at ASC,session_id ASC,seq ASC LIMIT 1",
            [source_ref],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(ConversationError::sqlite)?;
    id.map(|id| read_message(connection, &id))
        .transpose()
        .map(Option::flatten)
}
