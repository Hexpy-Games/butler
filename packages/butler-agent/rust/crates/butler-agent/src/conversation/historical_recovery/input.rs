use std::{fs, path::Path};

use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};

use super::super::{ConversationError, ConversationResult};
use crate::conversation::ConversationCode;

#[derive(Clone, Debug)]
pub(crate) struct HistoricalTranscriptRow {
    pub(crate) event_id: String,
    pub(crate) session_id: String,
    pub(crate) kind: String,
    pub(crate) timestamp: String,
    pub(crate) transport: Option<String>,
    pub(crate) payload: Option<Map<String, Value>>,
}

#[derive(Clone, Debug)]
pub(crate) struct HistoricalAppProjectionRow {
    pub(crate) id: String,
    pub(crate) chat_id: String,
    pub(crate) role: String,
    pub(crate) text: Option<String>,
    pub(crate) created_at: String,
    pub(crate) conversation_session_id: Option<String>,
    pub(crate) conversation_turn_id: Option<String>,
    pub(crate) conversation_message_id: Option<String>,
}

pub(crate) struct HistoricalRecoveryInput {
    pub(crate) transcript_rows: Vec<HistoricalTranscriptRow>,
    pub(crate) app_rows: Vec<HistoricalAppProjectionRow>,
    pub(crate) dry_run: bool,
}

pub(crate) fn read_historical_transcript_rows(
    path: &Path,
) -> ConversationResult<Vec<HistoricalTranscriptRow>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(input_error("Unable to read transcript input")),
    };
    let text = String::from_utf8_lossy(&bytes);
    Ok(text
        .split('\n')
        .enumerate()
        .filter_map(|(index, line)| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(value) => {
                    let payload = value.get("payload").and_then(Value::as_object).cloned();
                    Some(HistoricalTranscriptRow {
                        event_id: js_string(value.get("eventId")),
                        session_id: js_string(value.get("sessionId")),
                        kind: js_string(value.get("kind")),
                        timestamp: js_string(value.get("timestamp")),
                        transport: value
                            .get("transport")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        payload,
                    })
                }
                Err(_) => Some(HistoricalTranscriptRow {
                    event_id: format!("malformed-line-{}", index + 1),
                    session_id: "unknown".into(),
                    kind: "malformed_json".into(),
                    timestamp: String::new(),
                    transport: None,
                    payload: None,
                }),
            }
        })
        .collect())
}

pub(crate) fn read_historical_app_rows(
    path: &Path,
) -> ConversationResult<Vec<HistoricalAppProjectionRow>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|source| input_error("Unable to open app projection input").with_source(source))?;
    let rows = (|| {
        let table: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name='messages')",
                [],
                |row| row.get(0),
            )
            .map_err(ConversationError::sqlite)?;
        if !table {
            return Ok(Vec::new());
        }
        let columns = {
            let mut statement = connection
                .prepare("PRAGMA table_info(messages)")
                .map_err(ConversationError::sqlite)?;
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(ConversationError::sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(ConversationError::sqlite)?
        };
        let optional = |name: &'static str| {
            if columns.iter().any(|column| column == name) {
                name
            } else {
                "NULL"
            }
        };
        let sql = format!(
            "SELECT id,chat_id,role,text,created_at,{}, {}, {} FROM messages ORDER BY created_at ASC,id ASC",
            optional("conversation_session_id"),
            optional("conversation_turn_id"),
            optional("conversation_message_id")
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(ConversationError::sqlite)?;
        statement
            .query_map([], |row| {
                Ok(HistoricalAppProjectionRow {
                    id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    chat_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    role: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    text: row.get(3)?,
                    created_at: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    conversation_session_id: row.get(5)?,
                    conversation_turn_id: row.get(6)?,
                    conversation_message_id: row.get(7)?,
                })
            })
            .map_err(ConversationError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(ConversationError::sqlite)
    })();
    connection
        .close()
        .map_err(|(_, error)| ConversationError::sqlite(error))?;
    rows
}

fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(value)) => value.clone(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(Some(value))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn input_error(message: &'static str) -> ConversationError {
    ConversationError::new(
        ConversationCode::ConversationRecoveryInputUnavailable,
        message,
    )
}
