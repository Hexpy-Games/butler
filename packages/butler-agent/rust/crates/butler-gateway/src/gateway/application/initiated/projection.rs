//! Indexed origin projection shared by reads and live events.
use super::super::AppStorageError;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};

pub(in crate::gateway::application) fn origin(
    db: &Connection,
    id: &str,
) -> Result<Option<Value>, AppStorageError> {
    let step: Option<String> = db.query_row("SELECT i.payload_json FROM messages m JOIN turns t ON t.id=m.turn_id JOIN app_initiated_messages i ON i.message_id=t.user_message_id WHERE m.id=?1 AND m.role='assistant' AND i.kind='canon_step'",[id],|r|r.get(0)).optional().map_err(AppStorageError::sqlite)?;
    if let Some(raw) = step {
        let payload: Value = serde_json::from_str(&raw).map_err(super::outbox::json_error)?;
        return Ok(Some(
            json!({"kind":"canon_step","quiet":false,"plan_title":payload["untrusted_content"]["plan_title"],"epic_title":payload["untrusted_content"]["epic_title"],"epic_id":payload["epic_id"]}),
        ));
    }
    let work: Option<String> = db.query_row(
        "SELECT json_extract(t.execution_controls_json,'$.subsession_result') FROM messages m JOIN turns t ON t.id=m.turn_id WHERE m.id=?1 AND m.role='assistant' AND json_valid(t.execution_controls_json) AND json_extract(t.execution_controls_json,'$.subsession_result.child_session_id') IS NOT NULL",
        [id], |r| r.get(0)).optional().map_err(AppStorageError::sqlite)?;
    if let Some(raw) = work {
        let quiet = self::quiet(db, id)?;
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
         WHERE m.id=?1 AND m.role='assistant'
         AND CASE WHEN json_valid(t.execution_controls_json)
         THEN json_extract(t.execution_controls_json,'$.schedule_run') END IS NOT NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let quiet = quiet(db, id)?;
    Ok(schedule.map(|(id, title)| {
        json!({"kind":"schedule_report","quiet":quiet,
        "automation_id":id,"automation_title":title})
    }))
}

/// Both live and read projections use the decision saved with admission/post.
pub(in crate::gateway::application) fn quiet(
    db: &Connection,
    id: &str,
) -> Result<bool, AppStorageError> {
    db.query_row("SELECT COALESCE(i.quiet,t.quiet,0) FROM messages m LEFT JOIN turns t ON t.id=m.turn_id LEFT JOIN app_initiated_messages i ON i.message_id=m.id WHERE m.id=?1 AND m.role='assistant'",
        [id], |r| r.get(0)).optional().map(|v| v.unwrap_or(false)).map_err(AppStorageError::sqlite)
}
