//! Public App read projections over the single SQLite owner.

mod artifacts;
mod plan;
#[cfg(test)]
mod window_tests;

use std::collections::BTreeMap;
use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::storage::AppStorageError;
use crate::gateway::TurnProgressSnapshotView;
use crate::gateway::{
    ChangedFileDetail, MessageFileRef, MessageListView, MessageRecord, SessionArtifactSummary,
    TurnListView, TurnRecord,
};
use artifacts::artifact;
pub(super) use plan::latest_plan_document_status;

const PAGE_LIMIT: usize = 200;

pub(super) fn list_messages(
    connection: &Connection,
    chat_id: &str,
    after_cursor: f64,
    limit: usize,
) -> Result<MessageListView, AppStorageError> {
    Ok(list_message_page(
        connection,
        chat_id,
        (after_cursor > 0.0).then(|| message_cursor(after_cursor)),
        None,
        limit,
    )?
    .view)
}

pub(super) struct SessionMessagePage {
    pub view: MessageListView,
    pub has_more: bool,
}

pub(super) fn list_message_page(
    connection: &Connection,
    chat_id: &str,
    after_cursor: Option<u64>,
    before_cursor: Option<u64>,
    limit: usize,
) -> Result<SessionMessagePage, AppStorageError> {
    require_chat(connection, chat_id)?;
    let bounded = limit.clamp(1, PAGE_LIMIT);
    let (operator, cursor, order, reverse) = if let Some(before) = before_cursor {
        ("<", before, "DESC", true)
    } else if let Some(after) = after_cursor {
        (">", after, "ASC", false)
    } else {
        (">", 0, "DESC", true)
    };
    let query = format!(
        "SELECT rowid,id,chat_id,turn_id,conversation_session_id,conversation_turn_id,\
         conversation_message_id,role,text,content_parts_json,status,created_at,updated_at,\
         safe_error_code,retryable,plan_json FROM messages WHERE chat_id=?1 AND rowid{operator}?2 \
         AND NOT (role='assistant' AND safe_error_code IS NOT NULL AND \
         safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete')) \
         ORDER BY rowid {order} LIMIT ?3"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(AppStorageError::sqlite)?;
    let mut rows = statement
        .query_map(params![chat_id, cursor, bounded + 1], |row| {
            Ok(MessageRow {
                cursor: row.get(0)?,
                id: row.get(1)?,
                chat_id: row.get(2)?,
                turn_id: row.get(3)?,
                conversation_session_id: row.get(4)?,
                conversation_turn_id: row.get(5)?,
                conversation_message_id: row.get(6)?,
                role: row.get(7)?,
                text: row.get(8)?,
                content_parts_json: row.get(9)?,
                status: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
                safe_error_code: row.get(13)?,
                retryable: row.get(14)?,
                plan_json: row.get(15)?,
            })
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let has_more = rows.len() > bounded;
    rows.truncate(bounded);
    if reverse {
        rows.reverse();
    }
    let ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
    let attachments = attachments(connection, &ids)?;
    let changed_files = changed_files(connection, &ids)?;
    let mut messages = rows
        .into_iter()
        .map(|row| message(row, &attachments, &changed_files))
        .collect::<Result<Vec<_>, _>>()?;
    let next_cursor = messages
        .last()
        .map_or(cursor as f64, |message| message.cursor as f64);
    let turn_progress = progress_for_messages(connection, &messages)?;
    super::message_projection::decorate(connection, &mut messages, &turn_progress)?;
    Ok(SessionMessagePage {
        view: MessageListView {
            chat_id: chat_id.to_owned(),
            messages,
            turn_progress: (!turn_progress.is_empty()).then_some(turn_progress),
            next_cursor,
        },
        has_more,
    })
}

/// Read the source-shaped artifact projection from the latest visible message
/// window without constructing full message records or progress rows.
pub(super) fn list_artifacts(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<SessionArtifactSummary>, AppStorageError> {
    artifacts::list(connection, session_id)
}

fn progress_for_messages(
    db: &Connection,
    messages: &[MessageRecord],
) -> Result<BTreeMap<String, TurnProgressSnapshotView>, AppStorageError> {
    let mut output = BTreeMap::new();
    for turn_id in messages
        .iter()
        .filter_map(|message| message.turn_id.as_deref())
    {
        if output.contains_key(turn_id) {
            continue;
        }
        if let Some(progress) = super::progress_view::read(db, turn_id)? {
            output.insert(turn_id.to_owned(), progress);
        }
    }
    Ok(output)
}

pub(super) fn list_turns(
    connection: &Connection,
    chat_id: &str,
    after_cursor: f64,
) -> Result<TurnListView, AppStorageError> {
    require_chat(connection, chat_id)?;
    let cursor = turn_cursor(after_cursor);
    let mut statement = connection.prepare(
        "SELECT rowid,id,chat_id,user_message_id,state,safe_status_label,safe_error_code,\
         retryable,cancellable,attempt,execution_controls_json,execution_model_json,created_at,updated_at \
         FROM turns WHERE chat_id=?1 AND rowid>?2 ORDER BY rowid ASC LIMIT 200",
    ).map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map(params![chat_id, cursor], turn_row)
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let turns = rows.into_iter().map(turn).collect::<Result<Vec<_>, _>>()?;
    let next_cursor = turns.last().map_or(cursor, |row| row.cursor as f64);
    Ok(TurnListView {
        chat_id: chat_id.to_owned(),
        turns,
        next_cursor,
    })
}

pub(super) fn latest_turn(
    connection: &Connection,
    chat_id: &str,
) -> Result<Option<TurnRecord>, AppStorageError> {
    require_chat(connection, chat_id)?;
    connection
        .query_row(
            "SELECT rowid,id,chat_id,user_message_id,state,safe_status_label,safe_error_code,\
             retryable,cancellable,attempt,execution_controls_json,execution_model_json,created_at,updated_at \
             FROM turns WHERE chat_id=?1 ORDER BY rowid DESC LIMIT 1",
            [chat_id],
            turn_row,
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .map(turn)
        .transpose()
}

pub(super) fn exact_turn(
    connection: &Connection,
    turn_id: &str,
) -> Result<Option<TurnRecord>, AppStorageError> {
    connection
        .query_row(
            "SELECT rowid,id,chat_id,user_message_id,state,safe_status_label,safe_error_code,\
             retryable,cancellable,attempt,execution_controls_json,execution_model_json,created_at,updated_at \
             FROM turns WHERE id=?1",
            [turn_id],
            turn_row,
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .map(turn)
        .transpose()
}

pub(super) fn latest_message_cursor(
    connection: &Connection,
    chat_id: &str,
) -> Result<u64, AppStorageError> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(rowid),0) FROM messages WHERE chat_id=?1",
            [chat_id],
            |row| row.get(0),
        )
        .map_err(AppStorageError::sqlite)
}

struct MessageRow {
    cursor: u64,
    id: String,
    chat_id: String,
    turn_id: Option<String>,
    conversation_session_id: Option<String>,
    conversation_turn_id: Option<String>,
    conversation_message_id: Option<String>,
    role: String,
    text: String,
    content_parts_json: Option<String>,
    status: String,
    created_at: String,
    updated_at: String,
    safe_error_code: Option<String>,
    retryable: i64,
    plan_json: Option<String>,
}

struct TurnRow {
    cursor: u64,
    id: String,
    chat_id: String,
    user_message_id: Option<String>,
    state: String,
    safe_status_label: String,
    safe_error_code: Option<String>,
    retryable: i64,
    cancellable: i64,
    attempt: u64,
    execution_controls_json: Option<String>,
    execution_model_json: Option<String>,
    created_at: String,
    updated_at: String,
}

fn turn_row(row: &Row<'_>) -> rusqlite::Result<TurnRow> {
    Ok(TurnRow {
        cursor: row.get(0)?,
        id: row.get(1)?,
        chat_id: row.get(2)?,
        user_message_id: row.get(3)?,
        state: row.get(4)?,
        safe_status_label: row.get(5)?,
        safe_error_code: row.get(6)?,
        retryable: row.get(7)?,
        cancellable: row.get(8)?,
        attempt: row.get(9)?,
        execution_controls_json: row.get(10)?,
        execution_model_json: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn message(
    row: MessageRow,
    attachments: &HashMap<String, Vec<MessageFileRef>>,
    changed: &HashMap<String, Vec<ChangedFileDetail>>,
) -> Result<MessageRecord, AppStorageError> {
    let files = attachments.get(&row.id).cloned().unwrap_or_default();
    let artifacts =
        (row.role == "assistant").then(|| files.iter().map(|file| artifact(&row, file)).collect());
    Ok(MessageRecord {
        content_parts: parse_optional(row.content_parts_json.as_deref())?,
        id: row.id.clone(),
        chat_id: row.chat_id,
        turn_id: row.turn_id.clone(),
        conversation_session_id: row.conversation_session_id,
        conversation_turn_id: row.conversation_turn_id,
        conversation_message_id: row.conversation_message_id,
        role: parse_enum(&row.role)?,
        text: row.text,
        status: parse_enum(&row.status)?,
        created_at: row.created_at,
        updated_at: row.updated_at,
        safe_error_code: row.safe_error_code,
        delivery_state: None,
        limitation_codes: None,
        limitations: None,
        retryable: row.retryable == 1,
        cursor: row.cursor,
        attachments: (!files.is_empty()).then_some(files),
        artifacts: artifacts.filter(|items: &Vec<_>| !items.is_empty()),
        changed_files: changed
            .get(&row.id)
            .cloned()
            .filter(|items| !items.is_empty()),
        plan_document: parse_optional(row.plan_json.as_deref())?,
        work_blocks: None,
        turn_activity_rows: None,
    })
}

fn turn(row: TurnRow) -> Result<TurnRecord, AppStorageError> {
    Ok(TurnRecord {
        id: row.id,
        chat_id: row.chat_id,
        user_message_id: row.user_message_id,
        state: parse_enum(&row.state)?,
        safe_status_label: row.safe_status_label,
        safe_error_code: row.safe_error_code,
        retryable: row.retryable == 1,
        cancellable: row.cancellable == 1,
        attempt: row.attempt,
        created_at: row.created_at,
        updated_at: row.updated_at,
        cursor: row.cursor,
        execution_controls: parse_optional(row.execution_controls_json.as_deref())?,
        execution_model: parse_optional(row.execution_model_json.as_deref())?,
    })
}

fn attachments(
    connection: &Connection,
    ids: &[String],
) -> Result<HashMap<String, Vec<MessageFileRef>>, AppStorageError> {
    let mut result = HashMap::new();
    let mut statement = connection.prepare("SELECT f.id,f.kind,f.mime_type,f.safe_name,f.size_bytes,f.sha256,f.created_at \
        FROM message_attachments a JOIN message_files f ON f.id=a.file_id WHERE a.message_id=?1 ORDER BY a.position")
        .map_err(AppStorageError::sqlite)?;
    for id in ids {
        let rows = statement
            .query_map([id], |row| {
                file_ref_from_values(
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                )
            })
            .map_err(AppStorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppStorageError::sqlite)?;
        result.insert(id.clone(), rows);
    }
    Ok(result)
}

pub(super) fn message_file_ref(
    row: &super::AppMessageFileSnapshot,
) -> Result<MessageFileRef, AppStorageError> {
    file_ref_from_values(
        row.id.clone(),
        row.kind.clone(),
        row.mime_type.clone(),
        row.safe_name.clone(),
        row.size_bytes,
        row.sha256.clone(),
        row.created_at.clone(),
    )
    .map_err(AppStorageError::sqlite)
}

fn file_ref_from_values(
    id: String,
    kind: String,
    mime_type: String,
    safe_name: String,
    size_bytes: u64,
    sha256: String,
    created_at: String,
) -> rusqlite::Result<MessageFileRef> {
    Ok(MessageFileRef {
        url: format!("/message-files/{}", encode_component(&id)),
        file_id: id,
        kind: parse_sql_enum(kind)?,
        mime_type,
        safe_name,
        size_bytes,
        sha256,
        created_at,
    })
}

fn changed_files(
    connection: &Connection,
    ids: &[String],
) -> Result<HashMap<String, Vec<ChangedFileDetail>>, AppStorageError> {
    let mut result = HashMap::new();
    let mut statement = connection
        .prepare(
            "SELECT safe_path_label,detail_json FROM message_changed_files \
        WHERE message_id=?1 ORDER BY position",
        )
        .map_err(AppStorageError::sqlite)?;
    for id in ids {
        let rows = statement
            .query_map([id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(AppStorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppStorageError::sqlite)?;
        let values = rows
            .into_iter()
            .filter_map(|(path, json)| json.map(|json| (path, json)))
            .map(|(path, json)| {
                let mut detail =
                    serde_json::from_str::<ChangedFileDetail>(&json).map_err(|error| {
                        AppStorageError::new("app_projection_json_invalid", error.to_string())
                    })?;
                detail.path = path;
                Ok(detail)
            })
            .collect::<Result<Vec<_>, AppStorageError>>()?;
        result.insert(id.clone(), values);
    }
    Ok(result)
}

fn require_chat(connection: &Connection, chat_id: &str) -> Result<(), AppStorageError> {
    let found = connection
        .query_row("SELECT 1 FROM chats WHERE id=?1", [chat_id], |_| Ok(()))
        .optional()
        .map_err(AppStorageError::sqlite)?;
    found.ok_or_else(|| AppStorageError::new("session_not_found", "Session not found."))
}

fn message_cursor(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        value.floor() as u64
    } else {
        0
    }
}
fn turn_cursor(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}
fn parse_enum<T: DeserializeOwned>(value: &str) -> Result<T, AppStorageError> {
    serde_json::from_value(Value::String(value.to_owned()))
        .map_err(|error| AppStorageError::new("app_projection_value_invalid", error.to_string()))
}
fn parse_sql_enum<T: DeserializeOwned>(value: String) -> rusqlite::Result<T> {
    serde_json::from_value(Value::String(value)).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}
fn parse_optional<T: DeserializeOwned>(value: Option<&str>) -> Result<Option<T>, AppStorageError> {
    value
        .map(|json| {
            serde_json::from_str(json).map_err(|error| {
                AppStorageError::new("app_projection_json_invalid", error.to_string())
            })
        })
        .transpose()
}
fn encode_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
