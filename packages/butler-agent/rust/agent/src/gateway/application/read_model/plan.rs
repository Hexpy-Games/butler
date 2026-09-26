use rusqlite::Connection;
use serde_json::Value;

use super::super::storage::AppStorageError;

pub(in crate::gateway::application) fn latest_plan_document_status(
    connection: &Connection,
    chat_id: &str,
    plan_id: &str,
) -> Result<Option<String>, AppStorageError> {
    super::require_chat(connection, chat_id)?;
    let mut statement = connection
        .prepare(
            "SELECT plan_json FROM messages WHERE chat_id=?1 AND role='assistant' \
             AND plan_json IS NOT NULL AND NOT (safe_error_code IS NOT NULL AND \
             safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete')) \
             ORDER BY rowid DESC",
        )
        .map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map([chat_id], |row| row.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?;
    for row in rows {
        let encoded = row.map_err(AppStorageError::sqlite)?;
        let document = serde_json::from_str::<Value>(&encoded).map_err(|error| {
            AppStorageError::new("app_projection_json_invalid", error.to_string())
        })?;
        if document.get("id").and_then(Value::as_str) == Some(plan_id) {
            return Ok(document
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_owned));
        }
    }
    Ok(None)
}
