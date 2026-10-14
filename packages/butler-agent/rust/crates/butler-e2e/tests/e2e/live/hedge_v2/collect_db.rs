//! Read only the fresh scenario database; operation output may be absent.
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::path::Path;
#[path = "collect_tools.rs"]
mod operations;

pub(crate) fn snapshot(path: &Path, full: bool) -> Result<Value, HarnessError> {
    let db =
        butler_platform::sqlite::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let delegated: u64 = db.query_row("SELECT count(*) FROM btcc_subsession_delegations WHERE json_extract(packet_json,'$.child_role')='steward'", [], |r|r.get(0))?;
    let handback: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_guided_tool_calls WHERE tool_name='browser_wait_for_user' AND status='completed')", [], |r|r.get(0))?;
    if !full {
        return Ok(json!({"delegated":delegated>0,"delegations":delegated,"handback":handback}));
    }
    let mut stmt = db.prepare("SELECT c.arguments_json FROM btcc_guided_tool_calls c JOIN btcc_turns t ON t.turn_id=c.turn_id WHERE c.tool_name='replace_work_plan' AND COALESCE(json_extract(t.context_json,'$.executionPolicy.role'),'butler')!='worker' ORDER BY c.rowid")?;
    let mut plans = Vec::new();
    for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
        let value: Value = serde_json::from_str(&row?).unwrap_or(Value::Null);
        plans.push(value["checks"].clone());
    }
    let mut stmt = db.prepare("SELECT s.summary FROM btcc_steward_results s JOIN btcc_subsession_delegations d ON d.relation_id=s.relation_id WHERE json_extract(d.packet_json,'$.child_role')='steward' ORDER BY s.rowid")?;
    let reports = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let model_requests: u64 = db.query_row(
        "SELECT count(*) FROM btcc_model_route_events WHERE event_type='model.attempt.started'",
        [],
        |r| r.get(0),
    )?;
    Ok(
        json!({"model_requests":model_requests,"tools":operations::tools(&db)?,"plan_checks":plans,"steward_reports":reports,"delegated":delegated>0,"delegations":delegated,"handback":handback}),
    )
}

/// A command approval never removes its workspace and no-network boundary.
pub(super) fn contained_command(path: &Path, reference: &str) -> Result<bool, HarnessError> {
    let db =
        butler_platform::sqlite::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let raw: String = db.query_row(
        "SELECT normalized_input_json FROM btcc_authority_requests WHERE request_ref=?1",
        [reference],
        |row| row.get(0),
    )?;
    let args: Value = serde_json::from_str(&raw)?;
    if args["sandbox"] == "none" || args["state_effect"] == "remote_observation" {
        return Ok(false);
    }
    Ok(
        if matches!(
            args["state_effect"].as_str(),
            Some("read_only" | "validation")
        ) {
            butler_platform::command_sandbox::approval_free_reads()
        } else {
            butler_platform::command_sandbox::project_write_available()
        },
    )
}
