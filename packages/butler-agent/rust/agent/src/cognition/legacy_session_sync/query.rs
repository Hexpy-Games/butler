use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::cognition::{CognitionError, CognitionResult, ensure_data_authority};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS conversation_messages (
  source_id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  transcript_file TEXT,
  internal INTEGER NOT NULL DEFAULT 0,
  placeholder INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_messages_role_created_idx
  ON conversation_messages(role, created_at, source_id);
CREATE INDEX IF NOT EXISTS conversation_messages_session_role_created_idx
  ON conversation_messages(session_id, role, created_at, source_id);
CREATE INDEX IF NOT EXISTS conversation_messages_created_idx
  ON conversation_messages(created_at, source_id);
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts
  USING fts5(text, tokenize = 'unicode61');
";

const UPSERT: &str = "
INSERT INTO conversation_messages (
  source_id, source_event_id, session_id, role, text, created_at,
  transcript_file, internal, placeholder, updated_at
)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
ON CONFLICT(source_id) DO UPDATE SET
  source_event_id = excluded.source_event_id,
  session_id = excluded.session_id,
  role = excluded.role,
  text = excluded.text,
  created_at = excluded.created_at,
  transcript_file = excluded.transcript_file,
  internal = excluded.internal,
  placeholder = excluded.placeholder,
  updated_at = excluded.updated_at
";

#[derive(Clone, Debug)]
struct IndexMessage {
    source_id: String,
    event_id: String,
    session_id: String,
    role: &'static str,
    text: String,
    created_at: String,
    transcript_file: String,
    internal: bool,
    placeholder: bool,
}

pub(super) fn index(
    data_root: &Path,
    transcript_file: &Path,
    lines: &[String],
) -> CognitionResult<usize> {
    let transcript_file = transcript_file.to_string_lossy().into_owned();
    let mut projected = lines
        .iter()
        .filter_map(|line| project_line(line, &transcript_file));
    let Some(first) = projected.next() else {
        return Ok(0);
    };

    let query_dir = data_root.join("cognition/memory/query");
    let database_path = query_dir.join("messages.sqlite");
    let journal_path = query_dir.join("messages.sqlite-journal");
    let wal_path = query_dir.join("messages.sqlite-wal");
    let shm_path = query_dir.join("messages.sqlite-shm");
    ensure_query_authority(
        data_root,
        &query_dir,
        &database_path,
        &journal_path,
        &wal_path,
        &shm_path,
    )?;
    fs::create_dir_all(&query_dir).map_err(|_| unavailable())?;
    ensure_query_authority(
        data_root,
        &query_dir,
        &database_path,
        &journal_path,
        &wal_path,
        &shm_path,
    )?;

    let mut connection = Connection::open(&database_path).map_err(db_error)?;
    connection.execute_batch(SCHEMA).map_err(db_error)?;
    let updated_at = current_iso_timestamp()?;
    let transaction = connection.transaction().map_err(db_error)?;
    let indexed = {
        let mut upsert = transaction.prepare_cached(UPSERT).map_err(db_error)?;
        let mut rowid_query = transaction
            .prepare_cached("SELECT rowid FROM conversation_messages WHERE source_id = ?1")
            .map_err(db_error)?;
        let mut delete_fts = transaction
            .prepare_cached("DELETE FROM conversation_messages_fts WHERE rowid = ?1")
            .map_err(db_error)?;
        let mut insert_fts = transaction
            .prepare_cached("INSERT INTO conversation_messages_fts(rowid, text) VALUES (?1, ?2)")
            .map_err(db_error)?;

        let mut count = 0;
        for message in std::iter::once(first).chain(projected) {
            upsert
                .execute(params![
                    message.source_id,
                    message.event_id,
                    message.session_id,
                    message.role,
                    message.text,
                    message.created_at,
                    message.transcript_file,
                    if message.internal { 1_i64 } else { 0_i64 },
                    if message.placeholder { 1_i64 } else { 0_i64 },
                    updated_at,
                ])
                .map_err(db_error)?;
            if let Some(rowid) = rowid_query
                .query_row([&message.source_id], |row| row.get::<_, i64>(0))
                .optional()
                .map_err(db_error)?
            {
                delete_fts.execute([rowid]).map_err(db_error)?;
                insert_fts
                    .execute(params![rowid, message.text])
                    .map_err(db_error)?;
            }
            count += 1;
        }
        count
    };
    transaction.commit().map_err(db_error)?;
    Ok(indexed)
}

fn ensure_query_authority(
    data_root: &Path,
    query_dir: &Path,
    database: &Path,
    journal: &Path,
    wal: &Path,
    shm: &Path,
) -> CognitionResult<()> {
    ensure_data_authority(data_root, &[query_dir, database, journal, wal, shm])
}

fn project_line(line: &str, transcript_file: &str) -> Option<IndexMessage> {
    let trimmed = js_trim(line);
    let value = serde_json::from_str::<Value>(&trimmed).ok()?;
    let event = value.as_object()?;
    let event_id = event.get("eventId")?.as_str()?;
    let session_id = event.get("sessionId")?.as_str()?;
    let kind = event.get("kind")?.as_str()?;
    let role = match kind {
        "inbound" => "user",
        "outbound" => "assistant",
        _ => return None,
    };
    let timestamp = event.get("timestamp")?.as_str()?;
    let payload = event.get("payload")?;
    if !(payload.is_object() || payload.is_array()) {
        return None;
    }

    let text = event_text(payload)?;
    let timestamp_ms = crate::js_date::parse_iso_millis(timestamp)?;
    let created_at = crate::js_date::format_iso_millis(timestamp_ms)?;
    let internal = session_id.starts_with("steward/")
        || nullish(payload.get("route").and_then(|route| route.get("role")))
            .or_else(|| nullish(payload.get("role")))
            .and_then(Value::as_str)
            == Some("steward");
    let placeholder = timestamp_ms <= 0
        || (event.get("transport").and_then(Value::as_str) == Some("mock")
            && timestamp_ms < 946_684_800_000)
        || payload
            .get("eventId")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("mock:"))
        || payload
            .get("message")
            .and_then(Value::as_object)
            .and_then(|message| message.get("timestamp"))
            .and_then(Value::as_str)
            .and_then(crate::js_date::parse_iso_millis)
            .is_some_and(|millis| millis <= 0);

    Some(IndexMessage {
        source_id: format!("transcript:{event_id}"),
        event_id: event_id.to_owned(),
        session_id: session_id.to_owned(),
        role,
        text,
        created_at,
        transcript_file: transcript_file.to_owned(),
        internal,
        placeholder,
    })
}

fn event_text(payload: &Value) -> Option<String> {
    let message_text = payload
        .get("message")
        .filter(|value| !value.is_null())
        .and_then(Value::as_object)
        .and_then(|message| message.get("text"))
        .filter(|value| !value.is_null());
    let text = message_text
        .or_else(|| payload.get("text"))
        .and_then(Value::as_str)?;
    let trimmed = js_trim(text);
    (!trimmed.is_empty()).then_some(trimmed)
}

fn nullish(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

fn js_trim(value: &str) -> String {
    value
        .trim_matches(|character: char| {
            matches!(
                character,
                '\u{0009}'..='\u{000d}'
                    | ' '
                    | '\u{00a0}'
                    | '\u{1680}'
                    | '\u{2000}'..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
            )
        })
        .to_owned()
}

fn current_iso_timestamp() -> CognitionResult<String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| unavailable())?
        .as_millis();
    let millis = i64::try_from(millis).map_err(|_| unavailable())?;
    crate::js_date::format_iso_millis(millis).ok_or_else(unavailable)
}

fn db_error(_: rusqlite::Error) -> CognitionError {
    unavailable()
}

fn unavailable() -> CognitionError {
    CognitionError::new(
        "memory_transcript_query_index_unavailable",
        "memory_transcript_query_index_unavailable",
    )
}

#[cfg(test)]
mod tests;
