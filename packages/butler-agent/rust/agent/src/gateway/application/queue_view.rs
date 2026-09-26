//! Public queued-message projection.

use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::storage::AppStorageError;
use crate::gateway::{
    MessageFileRef, QueueState, QueuedMessageRecord, SessionControlState, SessionQueueView,
};

pub(super) fn list(
    connection: &Connection,
    chat_id: &str,
) -> Result<SessionQueueView, AppStorageError> {
    let found = connection
        .query_row("SELECT 1 FROM chats WHERE id=?1", [chat_id], |_| Ok(()))
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if found.is_none() {
        return Err(AppStorageError::new(
            "session_not_found",
            "Session not found.",
        ));
    }

    let mut statement = connection
        .prepare(
            "SELECT rowid,id,chat_id,text,client_message_id,control_resolution_json,controls_json,\
         attachments_json,content_parts_json,state,safe_error_code,dispatched_message_id,turn_id,\
         terminal_result_message_id,created_at,updated_at FROM session_queued_messages \
         WHERE chat_id=?1 AND (state='queued' OR (state='failed' AND \
         COALESCE(safe_error_code, '') <> 'turn_cancelled')) ORDER BY rowid ASC",
        )
        .map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map([chat_id], |row| {
            Ok(QueueRow {
                cursor: row.get(0)?,
                id: row.get(1)?,
                chat_id: row.get(2)?,
                text: row.get(3)?,
                client_message_id: row.get(4)?,
                control_resolution_json: row.get(5)?,
                controls_json: row.get(6)?,
                attachments_json: row.get(7)?,
                content_parts_json: row.get(8)?,
                state: row.get(9)?,
                safe_error_code: row.get(10)?,
                dispatched_message_id: row.get(11)?,
                turn_id: row.get(12)?,
                terminal_result_message_id: row.get(13)?,
                created_at: row.get(14)?,
                updated_at: row.get(15)?,
            })
        })
        .map_err(AppStorageError::sqlite)?;
    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let queued_messages = rows
        .into_iter()
        .map(|row| queue_record(connection, row))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SessionQueueView {
        session_id: chat_id.to_owned(),
        queued_messages,
    })
}

pub(super) fn queued_message(
    connection: &Connection,
    chat_id: &str,
    client_id: &str,
) -> Result<Option<QueuedMessageRecord>, AppStorageError> {
    let row = connection
        .query_row(
            "SELECT rowid,id,chat_id,text,client_message_id,control_resolution_json,controls_json,\
         attachments_json,content_parts_json,state,safe_error_code,dispatched_message_id,turn_id,\
         terminal_result_message_id,created_at,updated_at FROM session_queued_messages \
         WHERE chat_id=?1 AND client_message_id=?2",
            params![chat_id, client_id],
            |row| {
                Ok(QueueRow {
                    cursor: row.get(0)?,
                    id: row.get(1)?,
                    chat_id: row.get(2)?,
                    text: row.get(3)?,
                    client_message_id: row.get(4)?,
                    control_resolution_json: row.get(5)?,
                    controls_json: row.get(6)?,
                    attachments_json: row.get(7)?,
                    content_parts_json: row.get(8)?,
                    state: row.get(9)?,
                    safe_error_code: row.get(10)?,
                    dispatched_message_id: row.get(11)?,
                    turn_id: row.get(12)?,
                    terminal_result_message_id: row.get(13)?,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                })
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    row.map(|row| queue_record(connection, row)).transpose()
}

#[derive(Clone, Debug)]
pub(super) struct MutationRow {
    pub id: String,
    pub chat_id: String,
    pub text: String,
    pub input_identity_digest: Option<String>,
    pub control_resolution_json: Option<String>,
    pub controls_json: String,
    pub attachments_json: String,
    pub content_parts_json: Option<String>,
    pub project_source_refs_json: Option<String>,
    pub state: String,
}

pub(super) fn mutation_row(
    connection: &Connection,
    id: &str,
) -> Result<Option<MutationRow>, AppStorageError> {
    connection
        .query_row(
            "SELECT id,chat_id,text,input_identity_digest,\
             control_resolution_json,controls_json,attachments_json,content_parts_json,\
             project_source_refs_json,state FROM session_queued_messages WHERE id=?1",
            [id],
            |row| {
                Ok(MutationRow {
                    id: row.get(0)?,
                    chat_id: row.get(1)?,
                    text: row.get(2)?,
                    input_identity_digest: row.get(3)?,
                    control_resolution_json: row.get(4)?,
                    controls_json: row.get(5)?,
                    attachments_json: row.get(6)?,
                    content_parts_json: row.get(7)?,
                    project_source_refs_json: row.get(8)?,
                    state: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)
}

struct QueueRow {
    cursor: u64,
    id: String,
    chat_id: String,
    text: String,
    client_message_id: Option<String>,
    control_resolution_json: Option<String>,
    controls_json: String,
    attachments_json: String,
    content_parts_json: Option<String>,
    state: String,
    safe_error_code: Option<String>,
    dispatched_message_id: Option<String>,
    turn_id: Option<String>,
    terminal_result_message_id: Option<String>,
    created_at: String,
    updated_at: String,
}

fn queue_record(
    connection: &Connection,
    row: QueueRow,
) -> Result<QueuedMessageRecord, AppStorageError> {
    let attachment_values =
        serde_json::from_str::<Vec<Value>>(&row.attachments_json).unwrap_or_default();
    let ids = attachment_values
        .iter()
        .filter_map(|value| {
            value
                .as_str()
                .or_else(|| value.get("file_id").and_then(Value::as_str))
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let files = files_for_ids(connection, &ids)?;
    Ok(QueuedMessageRecord {
        content_parts: parse_optional(row.content_parts_json.as_deref())?,
        id: row.id,
        chat_id: row.chat_id,
        text: row.text,
        client_message_id: row.client_message_id,
        plan_id: public_plan_id(row.control_resolution_json.as_deref()),
        attachments: (!files.is_empty()).then_some(files),
        controls: serde_json::from_str::<SessionControlState>(&row.controls_json).map_err(
            |error| AppStorageError::new("app_projection_json_invalid", error.to_string()),
        )?,
        state: parse_enum::<QueueState>(&row.state)?,
        safe_error_code: row.safe_error_code,
        dispatched_message_id: row.dispatched_message_id,
        turn_id: row.turn_id,
        terminal_result_message_id: row.terminal_result_message_id,
        cursor: row.cursor,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn public_plan_id(resolution_json: Option<&str>) -> Option<String> {
    let resolution = serde_json::from_str::<Value>(resolution_json?).ok()?;
    let controls = resolution.get("controls")?;
    if controls.get("model")?.as_str().is_none()
        || resolution.get("sessionControlRevision")?.as_f64().is_none()
        || resolution.get("catalogGeneration")?.as_str().is_none()
    {
        return None;
    }
    resolution
        .get("plan_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

fn files_for_ids(
    connection: &Connection,
    ids: &[String],
) -> Result<Vec<MessageFileRef>, AppStorageError> {
    let mut files = Vec::with_capacity(ids.len());
    for id in ids {
        let file = connection.query_row(
            "SELECT id,kind,mime_type,safe_name,size_bytes,sha256,created_at FROM message_files WHERE id=?1",
            [id], |row| Ok(MessageFileRef {
                file_id: row.get(0)?, kind: parse_sql_enum(row.get::<_, String>(1)?)?,
                mime_type: row.get(2)?, safe_name: row.get(3)?, size_bytes: row.get(4)?,
                sha256: row.get(5)?, url: format!("/message-files/{}", encode_component(id)),
                created_at: row.get(6)?,
            }),
        ).optional().map_err(AppStorageError::sqlite)?;
        if let Some(file) = file {
            files.push(file);
        }
    }
    Ok(files)
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

#[cfg(test)]
mod tests {
    use super::public_plan_id;

    #[test]
    fn projects_only_plan_ids_from_source_valid_control_resolutions() {
        let resolution = r#"{"controls":{"model":"openai/gpt-test"},"sessionControlRevision":2,"catalogGeneration":"catalog-1","plan_id":"plan-1","private":"hidden"}"#;
        assert_eq!(public_plan_id(Some(resolution)).as_deref(), Some("plan-1"));
        assert_eq!(
            public_plan_id(Some(r#"{"controls":{},"plan_id":"plan-1"}"#)),
            None
        );
        assert_eq!(
            public_plan_id(Some(
                r#"{"controls":{"model":"openai/gpt-test"},"sessionControlRevision":2,"catalogGeneration":"catalog-1","plan_id":""}"#
            )),
            None
        );
    }
}
