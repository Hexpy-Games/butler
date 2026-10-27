//! Public App read projections over the single SQLite owner.
use crate::gateway::application::storage::CachedSql;

mod artifacts;
mod files;
pub(super) use files::message_file_ref;
use files::{attachments, changed_files, file_ref_from_values};
mod message_rows;
mod plan;
pub(super) use message_rows::{exact_message, streaming_message};

use std::collections::{BTreeMap, HashMap};

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::message_visibility::owner_visible;
use super::storage::AppStorageError;
use crate::gateway::TurnProgressSnapshotView;
use crate::gateway::application::storage::AppStorageCode;
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
        "SELECT m.rowid,m.id,o.chat_id,m.turn_id,m.conversation_session_id,m.conversation_turn_id,\
         m.conversation_message_id,m.role,m.text,m.content_parts_json,m.status,m.created_at,m.updated_at,\
         m.safe_error_code,m.retryable,m.plan_json,m.blocks_json,m.retry_mode,m.retry_with_current_controls,m.incomplete FROM app_message_owners o CROSS JOIN messages m \
         WHERE o.chat_id=?1 AND m.chat_id=o.source_chat_id \
         AND m.rowid BETWEEN o.first_rowid AND o.last_rowid AND m.rowid{operator}?2 \
         AND NOT (role='assistant' AND safe_error_code IS NOT NULL AND \
         safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete')) \
         AND {visible} ORDER BY m.rowid {order} LIMIT ?3",
        visible = owner_visible!()
    );
    let mut statement = connection
        .prepare_cached(&query)
        .map_err(AppStorageError::sqlite)?;
    let mut rows = statement
        .query_map(params![chat_id, cursor, bounded + 1], message_rows::read)
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
    let docs = artifacts::documents(connection, chat_id, &ids)?;
    let changed_files = changed_files(connection, &ids)?;
    let mut messages = rows
        .into_iter()
        .map(|row| {
            let documents = docs.get(&row.id).cloned().unwrap_or_default();
            let mut record = message(row, &attachments, &changed_files)?;
            if !documents.is_empty() {
                record
                    .artifacts
                    .get_or_insert_with(Vec::new)
                    .extend(documents);
            }
            Ok(record)
        })
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
    let mut statement = connection.prepare_cached(
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
        .query_row_cached(
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
        .query_row_cached(
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
        .query_row_cached(
            "SELECT COALESCE((SELECT m.rowid FROM app_message_owners o CROSS JOIN messages m \
             WHERE o.chat_id=?1 AND m.chat_id=o.source_chat_id \
             AND m.rowid BETWEEN o.first_rowid AND o.last_rowid ORDER BY m.rowid DESC LIMIT 1),0)",
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
    retry_mode: Option<String>,
    incomplete: Option<bool>,
    retry_with_current_controls: bool,
    plan_json: Option<String>,
    blocks_json: Option<String>,
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
    let changed = files::pair_changes(changed.get(&row.id).cloned().unwrap_or_default(), &files);
    let artifacts =
        (row.role == "assistant").then(|| files.iter().map(|file| artifact(&row, file)).collect());
    // Rows written by older builds have no mode, even after a previous upgrade.
    let legacy_resume = row.retry_mode.is_none()
        && row.retryable == 1
        && matches!(
            row.safe_error_code.as_deref(),
            Some("runtime_fault" | "turn_interrupted")
        );
    let retry_current = row.retry_with_current_controls
        || (legacy_resume && row.safe_error_code.as_deref() == Some("runtime_fault"));
    Ok(MessageRecord {
        incomplete: row.incomplete,
        initiated: None,
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
        retry_mode: row
            .retry_mode
            .as_deref()
            .or(legacy_resume.then_some("resume"))
            .map(parse_enum)
            .transpose()?,
        retry_with_current_controls: retry_current,
        cursor: row.cursor,
        attachments: (!files.is_empty()).then_some(files),
        artifacts: artifacts.filter(|items: &Vec<_>| !items.is_empty()),
        changed_files: (!changed.is_empty()).then_some(changed),
        plan_document: parse_optional(row.plan_json.as_deref())?,
        answer_blocks: super::message_projection::answer_blocks(row.blocks_json.as_deref())?,
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

fn require_chat(connection: &Connection, chat_id: &str) -> Result<(), AppStorageError> {
    let found = connection
        .query_row_cached("SELECT 1 FROM chats WHERE id=?1", [chat_id], |_| Ok(()))
        .optional()
        .map_err(AppStorageError::sqlite)?;
    found.ok_or_else(|| AppStorageError::new(AppStorageCode::SessionNotFound, "Session not found."))
}

fn message_cursor(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        butler_core::json::saturating_u64(value.floor())
    } else {
        0
    }
}
fn turn_cursor(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}
fn parse_enum<T: DeserializeOwned>(value: &str) -> Result<T, AppStorageError> {
    serde_json::from_value(Value::String(value.to_owned())).map_err(|error| {
        AppStorageError::new(AppStorageCode::AppProjectionValueInvalid, error.to_string())
            .with_source(error)
    })
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
                AppStorageError::new(AppStorageCode::AppProjectionJsonInvalid, error.to_string())
                    .with_source(error)
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
