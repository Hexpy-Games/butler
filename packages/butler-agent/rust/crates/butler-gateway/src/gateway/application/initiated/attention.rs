//! One durable notice per run and exact action, independent of its source session.
use super::{super::AppStorageError, outbox};
use rusqlite::Connection;
use serde_json::{Value, json};

pub(in crate::gateway::application) fn enqueue_attention(
    db: &Connection,
    automation: &str,
    run: &str,
    action: &Value,
    language: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    let approval: butler_turn::btcc::AuthorityApproval =
        serde_json::from_value(action["approval"].clone()).map_err(outbox::json_error)?;
    let title: String = db
        .query_row(
            "SELECT title FROM app_automations WHERE id=?1",
            [automation],
            |r| r.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    let identity = action
        .get("identity")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            json!({"capability":action["capability"],"approval":approval}).to_string()
        });
    let digest = butler_turn::btcc::digest_identity(&identity);
    let source = format!("approval-needed:{run}:{digest}");
    let id = format!(
        "approval-needed-{}",
        butler_turn::btcc::digest_identity(&source)
    );
    let exact = exact_action(&serde_json::to_value(&approval).map_err(outbox::json_error)?);
    let text = if language.starts_with("ko") {
        format!("확인 필요 · {exact} · {title}")
    } else {
        format!("Needs your OK · {exact} · {title}")
    };
    let mut payload = json!({"automation_id":automation,"automation_title":title,"run_id":run,"approval":approval});
    if let Some(work) = action.get("work_session_id").and_then(Value::as_str) {
        payload["work_session_id"] = json!(work);
    }
    outbox::enqueue(db, &id, &source, "approval_needed", &text, &payload, now)
}

fn exact_action(approval: &Value) -> String {
    let operation = &approval["operation"];
    if let Some(command) = operation.get("command").and_then(Value::as_str) {
        return command.to_owned();
    }
    let target = operation["targets"][0]
        .as_str()
        .or_else(|| approval["targets"][0]["path"].as_str())
        .unwrap_or("");
    let tool = operation["tool"].as_str().unwrap_or("");
    format!("{tool} {target}").trim().to_owned()
}
