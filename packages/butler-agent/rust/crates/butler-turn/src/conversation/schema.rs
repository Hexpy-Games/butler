use rusqlite::Connection;

use super::{ConversationError, ConversationIdentityClock, ConversationResult};

pub(super) const VERSION: u64 = 7;

const SQL: &str = r"
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id TEXT PRIMARY KEY, workspace_id TEXT, project_id TEXT, gateway_origin TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_bindings (
  gateway TEXT NOT NULL, external_session_id TEXT NOT NULL,
  conversation_session_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (gateway, external_session_id),
  FOREIGN KEY (conversation_session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS conversation_turns (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, actor TEXT NOT NULL,
  status TEXT NOT NULL, request_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, first_completed_at TEXT,
  UNIQUE (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, seq INTEGER NOT NULL,
  role TEXT NOT NULL, status TEXT NOT NULL, visibility TEXT NOT NULL, provenance TEXT NOT NULL,
  created_at TEXT NOT NULL, compacted_by_summary_id TEXT, source_gateway TEXT, source_ref TEXT,
  origin_kind TEXT NOT NULL DEFAULT 'unknown', origin_ref TEXT, origin_reason TEXT,
  origin_version TEXT, origin_evidence_json TEXT, UNIQUE (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES conversation_turns(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS conversation_parts (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, part_index INTEGER NOT NULL, kind TEXT NOT NULL,
  content_json TEXT NOT NULL, tool_call_id TEXT, parent_tool_call_id TEXT, provider_shape TEXT,
  status TEXT NOT NULL, UNIQUE (message_id, part_index),
  FOREIGN KEY (message_id) REFERENCES conversation_messages(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS conversation_summaries (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, covers_from_seq INTEGER NOT NULL,
  covers_to_seq INTEGER NOT NULL, source_hash TEXT NOT NULL, model TEXT, summary_text TEXT NOT NULL,
  created_at TEXT NOT NULL, invalidated_at TEXT,
  FOREIGN KEY (session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS conversation_turn_outcomes (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL, outcome TEXT NOT NULL, source_hash TEXT NOT NULL,
  request_message_id TEXT, public_assistant_message_id TEXT, provider_id TEXT, model_ref TEXT,
  evidence_refs_json TEXT NOT NULL, unresolved_obligations_json TEXT NOT NULL,
  continuation_json TEXT, safe_code TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES conversation_turns(id) ON DELETE CASCADE,
  FOREIGN KEY (request_message_id) REFERENCES conversation_messages(id) ON DELETE SET NULL,
  FOREIGN KEY (public_assistant_message_id) REFERENCES conversation_messages(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS conversation_projection_outbox (
  outbox_rowid INTEGER PRIMARY KEY AUTOINCREMENT, outbox_id TEXT NOT NULL UNIQUE,
  conversation_session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
  payload_ref TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS conversation_schema_migrations (
  version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_public_source_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL
);
INSERT OR IGNORE INTO conversation_public_source_state (singleton, revision) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS conversation_source_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), identity TEXT NOT NULL
);
DROP INDEX IF EXISTS conversation_turns_history_completion_idx;
DROP INDEX IF EXISTS conversation_parts_message_size_idx;
DROP INDEX IF EXISTS conversation_messages_session_turn_seq_idx;
CREATE INDEX IF NOT EXISTS conversation_turns_session_seq_idx ON conversation_turns(session_id, seq);
CREATE INDEX IF NOT EXISTS conversation_messages_session_seq_idx ON conversation_messages(session_id, seq);
CREATE INDEX IF NOT EXISTS conversation_messages_role_created_idx ON conversation_messages(role, created_at, id);
CREATE INDEX IF NOT EXISTS conversation_messages_session_role_created_idx ON conversation_messages(session_id, role, created_at, id);
CREATE INDEX IF NOT EXISTS conversation_messages_created_idx ON conversation_messages(created_at, id);
CREATE INDEX IF NOT EXISTS conversation_parts_message_part_idx ON conversation_parts(message_id, part_index);
CREATE INDEX IF NOT EXISTS conversation_parts_tool_call_idx ON conversation_parts(tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_bindings_gateway_external_idx ON conversation_bindings(gateway, external_session_id);
CREATE INDEX IF NOT EXISTS conversation_summaries_session_range_idx ON conversation_summaries(session_id, covers_from_seq, covers_to_seq);
CREATE INDEX IF NOT EXISTS conversation_turn_outcomes_session_created_idx ON conversation_turn_outcomes(session_id, created_at, turn_id);
";

pub(super) fn ensure(
    connection: &mut Connection,
    clock: &dyn ConversationIdentityClock,
) -> ConversationResult<()> {
    if current(connection)? {
        return Ok(());
    }
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(ConversationError::sqlite)?;
    // Another opener may have migrated while this connection waited for the write lock.
    if !current(&transaction)? {
        migrate(&transaction, clock)?;
    }
    transaction.commit().map_err(ConversationError::sqlite)
}

fn current(connection: &Connection) -> ConversationResult<bool> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='conversation_schema_migrations')",
        [], |row| row.get(0),
    ).map_err(ConversationError::sqlite)?;
    if !exists {
        return Ok(false);
    }
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM conversation_schema_migrations WHERE version=?1)",
            [VERSION],
            |row| row.get(0),
        )
        .map_err(ConversationError::sqlite)
}

fn migrate(
    connection: &Connection,
    clock: &dyn ConversationIdentityClock,
) -> ConversationResult<()> {
    connection
        .execute_batch(SQL)
        .map_err(ConversationError::sqlite)?;
    connection.execute(
        "INSERT OR IGNORE INTO conversation_source_identity (singleton, identity) VALUES (1, ?1)",
        [uuid::Uuid::new_v4().to_string()],
    ).map_err(ConversationError::sqlite)?;
    for (name, definition) in [
        ("origin_kind", "TEXT NOT NULL DEFAULT 'unknown'"),
        ("origin_ref", "TEXT"),
        ("origin_reason", "TEXT"),
        ("origin_version", "TEXT"),
        ("origin_evidence_json", "TEXT"),
    ] {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('conversation_messages') WHERE name=?1)",
            [name], |row| row.get(0),
        ).map_err(ConversationError::sqlite)?;
        if !exists {
            connection
                .execute_batch(&format!(
                    "ALTER TABLE conversation_messages ADD COLUMN {name} {definition}"
                ))
                .map_err(ConversationError::sqlite)?;
        }
    }
    let first_completion: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('conversation_turns') WHERE name='first_completed_at')",
        [], |row|row.get(0)).map_err(ConversationError::sqlite)?;
    if !first_completion {
        connection
            .execute_batch("ALTER TABLE conversation_turns ADD COLUMN first_completed_at TEXT")
            .map_err(ConversationError::sqlite)?;
    }
    connection.execute(
        "INSERT OR IGNORE INTO conversation_schema_migrations (version, applied_at) VALUES (?1, ?2)",
        rusqlite::params![VERSION, clock.now_iso()],
    ).map_err(ConversationError::sqlite)?;
    Ok(())
}
