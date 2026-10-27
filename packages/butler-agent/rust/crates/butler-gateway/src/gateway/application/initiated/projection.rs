//! Indexed origin projection shared by reads and live events.
use super::super::AppStorageError;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};

pub(in crate::gateway::application) fn origin(
    db: &Connection,
    id: &str,
) -> Result<Option<Value>, AppStorageError> {
    let work: Option<(String, bool)> = db.query_row(
        "SELECT json_extract(t.execution_controls_json,'$.subsession_result'),COALESCE((SELECT quiet FROM app_initiated_messages WHERE source_key='work-result:' || json_extract(t.execution_controls_json,'$.subsession_result.relation_id') || ':' || json_extract(t.execution_controls_json,'$.subsession_result.result_id')),0) FROM messages m JOIN turns t ON t.id=m.turn_id WHERE m.id=?1 AND m.role='assistant' AND t.chat_id='general' AND json_valid(t.execution_controls_json) AND json_extract(t.execution_controls_json,'$.subsession_result.child_session_id') IS NOT NULL",
        [id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(AppStorageError::sqlite)?;
    if let Some((raw, quiet)) = work {
        let context: Value = serde_json::from_str(&raw).map_err(super::outbox::json_error)?;
        return Ok(Some(json!({"kind":"work_result","quiet":quiet,
            "relation_id":context["relation_id"],"work_session_id":context["child_session_id"],
            "work_title":context["safe_title"]})));
    }
    let stored: Option<(String, String, bool)> = db.query_row(
        "SELECT kind,payload_json,quiet FROM app_initiated_messages WHERE message_id=?1 AND message_id IS NOT NULL AND kind!='work_result'",
        [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(AppStorageError::sqlite)?;
    if let Some((kind, payload, quiet)) = stored {
        let mut value: Value = serde_json::from_str(&payload).map_err(super::outbox::json_error)?;
        value["kind"] = json!(kind);
        value["quiet"] = json!(quiet);
        return Ok(Some(value));
    }
    let schedule: Option<(String, String)> = db
        .query_row(
            "SELECT a.id,a.title FROM messages m JOIN turns t ON t.id=m.turn_id
         JOIN app_automation_run_inputs i ON i.message_id=t.user_message_id
         JOIN app_automation_runs r ON r.id=i.run_id JOIN app_automations a ON a.id=r.automation_id
         WHERE m.id=?1 AND m.role='assistant' AND t.chat_id='general'
         AND CASE WHEN json_valid(t.execution_controls_json)
         THEN json_extract(t.execution_controls_json,'$.schedule_run') END IS NOT NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    Ok(schedule.map(|(id, title)| {
        json!({"kind":"schedule_report","quiet":false,
        "automation_id":id,"automation_title":title})
    }))
}
