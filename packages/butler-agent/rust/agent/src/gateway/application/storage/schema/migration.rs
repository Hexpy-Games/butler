use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::super::AppStorageError;

const COLUMNS: &[(&str, &str, &str)] = &[
    ("chats", "conversation_session_id", "TEXT"),
    ("chats", "pinned", "INTEGER NOT NULL DEFAULT 0"),
    ("chats", "archived", "INTEGER NOT NULL DEFAULT 0"),
    ("messages", "turn_id", "TEXT"),
    ("messages", "conversation_session_id", "TEXT"),
    ("messages", "conversation_turn_id", "TEXT"),
    ("messages", "conversation_message_id", "TEXT"),
    ("messages", "updated_at", "TEXT"),
    ("messages", "safe_error_code", "TEXT"),
    ("messages", "retryable", "INTEGER NOT NULL DEFAULT 0"),
    ("messages", "plan_json", "TEXT"),
    ("messages", "content_parts_json", "TEXT"),
    ("session_queued_messages", "content_parts_json", "TEXT"),
    (
        "session_queued_messages",
        "project_source_refs_json",
        "TEXT",
    ),
    ("message_changed_files", "detail_json", "TEXT"),
    ("projects", "ledger_project_id", "TEXT"),
    ("projects", "description", "TEXT"),
    ("projects", "dashboard_preferences_json", "TEXT"),
    (
        "projects",
        "dashboard_preferences_revision",
        "INTEGER NOT NULL DEFAULT 0",
    ),
    ("turns", "execution_controls_json", "TEXT"),
    ("turns", "safe_status_label_key", "TEXT"),
    ("turns", "safe_status_label_parameters_json", "TEXT"),
    ("turns", "safe_status_content_json", "TEXT"),
    ("turns", "execution_model_json", "TEXT"),
    ("session_queued_messages", "client_message_id", "TEXT"),
    ("session_queued_messages", "input_identity_digest", "TEXT"),
    ("session_queued_messages", "control_resolution_json", "TEXT"),
    ("session_queued_messages", "claim_id", "TEXT"),
    ("session_queued_messages", "claim_owner", "TEXT"),
    ("session_queued_messages", "claimed_at", "TEXT"),
    ("session_queued_messages", "lease_expires_at", "TEXT"),
    (
        "session_queued_messages",
        "terminal_result_message_id",
        "TEXT",
    ),
    ("events", "turn_id", "TEXT"),
    (
        "app_conversation_projection_state",
        "last_outcome_id",
        "TEXT",
    ),
    (
        "app_transcript_projection_checkpoints",
        "boundary_anchor_text",
        "TEXT NOT NULL DEFAULT ''",
    ),
    (
        "app_transcript_projection_checkpoints",
        "spool_path",
        "TEXT NOT NULL DEFAULT ''",
    ),
    (
        "app_transcript_projection_checkpoints",
        "spool_bytes",
        "INTEGER NOT NULL DEFAULT 0",
    ),
    (
        "app_transcript_projection_checkpoints",
        "spool_end_offset",
        "INTEGER NOT NULL DEFAULT 0",
    ),
];

pub(super) fn table_exists(connection: &Connection, table: &str) -> Result<bool, AppStorageError> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(AppStorageError::sqlite)
}

pub(super) fn add_current_columns(connection: &Connection) -> Result<(), AppStorageError> {
    for &(table, column, definition) in COLUMNS {
        ensure_column(connection, table, column, definition)?;
    }
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), AppStorageError> {
    let sql = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&sql).map_err(AppStorageError::sqlite)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    drop(statement);
    if names.iter().any(|name| name == column) {
        return Ok(());
    }
    connection
        .execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))
        .map_err(AppStorageError::sqlite)
}

pub(super) fn backfill_queue_identity(connection: &Connection) -> Result<(), AppStorageError> {
    let mut statement = connection
        .prepare(
            "SELECT id,text,client_message_id,input_identity_digest,control_resolution_json,\
             controls_json,attachments_json FROM session_queued_messages \
             WHERE client_message_id IS NULL OR input_identity_digest IS NULL \
                OR control_resolution_json IS NULL ORDER BY rowid ASC",
        )
        .map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map([], |row| {
            Ok(LegacyQueueRow {
                id: row.get(0)?,
                text: row.get(1)?,
                client_message_id: row.get(2)?,
                input_identity_digest: row.get(3)?,
                control_resolution_json: row.get(4)?,
                controls_json: row.get(5)?,
                attachments_json: row.get(6)?,
            })
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    drop(statement);
    for row in rows {
        let client_id = row
            .client_message_id
            .clone()
            .unwrap_or_else(|| legacy_client_id(&row.id));
        let digest = match row.input_identity_digest {
            Some(digest) => digest,
            None => legacy_identity_digest(connection, &row)?,
        };
        let resolution = row
            .control_resolution_json
            .or_else(|| legacy_control_resolution(&row.controls_json));
        connection
            .execute(
                "UPDATE session_queued_messages SET client_message_id=COALESCE(client_message_id,?1),\
                 input_identity_digest=COALESCE(input_identity_digest,?2),\
                 control_resolution_json=COALESCE(control_resolution_json,?3) WHERE id=?4",
                params![client_id, digest, resolution, row.id],
            )
            .map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}

pub(super) fn create_post_backfill_indexes(connection: &Connection) -> Result<(), AppStorageError> {
    connection
        .execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_message_idx \
               ON messages(conversation_message_id) WHERE conversation_message_id IS NOT NULL;\
             CREATE INDEX IF NOT EXISTS messages_conversation_session_idx \
               ON messages(conversation_session_id,conversation_turn_id);\
             CREATE INDEX IF NOT EXISTS chats_conversation_session_idx \
               ON chats(conversation_session_id);\
             CREATE UNIQUE INDEX IF NOT EXISTS session_queued_messages_client_idx \
               ON session_queued_messages(chat_id,client_message_id) WHERE client_message_id IS NOT NULL;\
             UPDATE chats SET kind='chat' WHERE kind='general';\
             UPDATE messages SET updated_at=created_at WHERE updated_at IS NULL;",
        )
        .map_err(AppStorageError::sqlite)
}

struct LegacyQueueRow {
    id: String,
    text: String,
    client_message_id: Option<String>,
    input_identity_digest: Option<String>,
    control_resolution_json: Option<String>,
    controls_json: String,
    attachments_json: String,
}

fn legacy_control_resolution(controls_json: &str) -> Option<String> {
    let controls = serde_json::from_str::<Value>(controls_json).ok()?;
    let controls = controls.as_object()?;
    let model = controls.get("model")?.as_str()?;
    if !model.contains('/') {
        return None;
    }
    serde_json::to_string(&json!({
        "controls": {
            "model": model,
            "reasoning_effort": controls.get("reasoning_effort").cloned().unwrap_or(Value::String("none".into())),
            "access_mode": controls.get("access_mode").cloned().unwrap_or(Value::String("full_access".into())),
            "plan_mode": controls.get("plan_mode") == Some(&Value::Bool(true))
        },
        "source": "session_override",
        "sessionControlRevision": 0,
        "catalogGeneration": "legacy"
    }))
    .ok()
}

fn legacy_client_id(queued_id: &str) -> String {
    let digest = sha256_hex(format!("legacy-client:{queued_id}").as_bytes());
    format!(
        "client-{}-{}-4{}-8{}-{}",
        &digest[0..8],
        &digest[8..12],
        &digest[13..16],
        &digest[17..20],
        &digest[20..32]
    )
}

fn legacy_identity_digest(
    connection: &Connection,
    row: &LegacyQueueRow,
) -> Result<String, AppStorageError> {
    let controls = serde_json::from_str::<Value>(&row.controls_json)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let attachments = serde_json::from_str::<Vec<Value>>(&row.attachments_json).unwrap_or_default();
    let mut admission = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let file_id = attachment
            .as_str()
            .or_else(|| attachment.get("file_id").and_then(Value::as_str))
            .unwrap_or("");
        admission
            .push(file_identity(connection, file_id)?.unwrap_or_else(|| json!({"id": file_id})));
    }
    let mut explicit = Map::new();
    for key in ["model", "reasoning_effort", "access_mode", "plan_mode"] {
        explicit.insert(
            key.to_owned(),
            controls.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    let value = json!({
        "version": 1,
        "text": row.text.trim(),
        "explicit_controls": explicit,
        "admission_identity": admission
    });
    let bytes = serde_json::to_vec(&value)
        .map_err(|error| AppStorageError::new("app_schema_json_failed", error.to_string()))?;
    Ok(sha256_hex(&bytes))
}

fn file_identity(connection: &Connection, file_id: &str) -> Result<Option<Value>, AppStorageError> {
    connection
        .query_row(
            "SELECT id,kind,mime_type,safe_name,size_bytes,sha256 FROM message_files WHERE id=?1",
            [file_id],
            |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "kind": row.get::<_, String>(1)?,
                    "mime_type": row.get::<_, String>(2)?,
                    "safe_name": row.get::<_, String>(3)?,
                    "size_bytes": row.get::<_, i64>(4)?,
                    "sha256": row.get::<_, String>(5)?
                }))
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
