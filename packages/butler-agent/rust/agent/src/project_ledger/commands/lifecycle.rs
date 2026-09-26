//! Canonical Project Ledger lifecycle mutations under the command owner's claim.

mod markdown;
mod options;
mod records;
pub(in crate::project_ledger) mod state;

use std::path::Path;

use serde_json::{Value, json};

use super::contracts::{CliFailure, LedgerCommand, LedgerCommandRequest};
use super::{envelope, refresh_index_after_mutation};
use crate::locale::LocaleCollation;

pub(super) fn execute(
    project_root: &Path,
    request: &LedgerCommandRequest,
    _collation: &LocaleCollation,
) -> Value {
    let result = match request.command {
        LedgerCommand::RecordCreate => records::create_top_level(project_root, &request.options),
        LedgerCommand::RecordUpdate => records::update_generic(project_root, &request.options),
        LedgerCommand::WorkCreate => records::create_work(project_root, &request.options),
        LedgerCommand::WorkUpdate => update_work(project_root, &request.options, false),
        LedgerCommand::WorkComplete => update_work(project_root, &request.options, true),
        LedgerCommand::TaskCreate => records::create_task(project_root, &request.options),
        LedgerCommand::TaskUpdate => update_task(project_root, &request.options, false),
        LedgerCommand::TaskComplete => update_task(project_root, &request.options, true),
        LedgerCommand::AttemptStart => start_attempt(project_root, &request.options),
        LedgerCommand::AttemptSucceed => {
            update_attempt(project_root, &request.options, "succeeded")
        }
        LedgerCommand::AttemptFail => update_attempt(project_root, &request.options, "failed"),
        _ => unreachable!("only lifecycle commands enter lifecycle::execute"),
    };
    envelope(request.command.label(), result)
}

fn update_work(root: &Path, options: &Value, complete: bool) -> Result<Value, CliFailure> {
    let id = options::required(options, "id")?;
    let current = super::show::resolve_record(root, &id, Some("work"))?;
    if complete && current.record.get("status").and_then(Value::as_str) == Some("done") {
        return Err(CliFailure::new(
            "invalid_transition",
            format!("Work is already completed: {id}"),
        ));
    }
    let status = if complete {
        Some("done")
    } else {
        options::optional(options, "status")
    };
    let fields = if complete {
        &[
            "spec",
            "acceptance",
            "validation",
            "review",
            "report",
            "codeCommits",
            "ledgerCommits",
        ][..]
    } else {
        &[
            "title",
            "spec",
            "acceptance",
            "validation",
            "review",
            "report",
            "implementation",
            "mitigation",
            "codeCommits",
            "ledgerCommits",
            "reason",
        ][..]
    };
    let mut updates = options::updates(options, fields)?;
    if let Some(status) = status {
        state::transition("work", &current.record, status, &id)?;
        updates.insert("status".into(), Value::String(status.into()));
        if status == "done" {
            state::work_completion_gate(&current.record, &updates)?;
        }
    }
    let body = options::body(options)?;
    markdown::update(&current.path, &updates, body.as_deref())?;
    let event = if complete {
        let report = updates
            .get("report")
            .cloned()
            .or_else(|| current.record.get("report").cloned())
            .unwrap_or(Value::Null);
        json!({"type":"work_completed","id":id,"report":report,"source":"project-ledger"})
    } else {
        json!({"type":"work_updated","id":id,"source":"project-ledger"})
    };
    markdown::append_event(root, &event)?;
    let record = read_back(root, &current.path)?;
    Ok(refresh_index_after_mutation(root, record))
}

fn update_task(root: &Path, options: &Value, complete: bool) -> Result<Value, CliFailure> {
    let id = options::required(options, "id")?;
    let current = super::show::resolve_record(root, &id, Some("task"))?;
    let status = if complete {
        Some("done")
    } else {
        options::optional(options, "status")
    };
    let mut updates = options::updates(
        options,
        &["title", "validation", "review", "report", "reason"],
    )?;
    if let Some(status) = status {
        state::transition("task", &current.record, status, &id)?;
        updates.insert("status".into(), Value::String(status.into()));
    }
    let body = options::body(options)?;
    markdown::update(&current.path, &updates, body.as_deref())?;
    markdown::append_event(
        root,
        &json!({"type":"task_updated","id":id,"source":"project-ledger"}),
    )?;
    let record = read_back(root, &current.path)?;
    Ok(refresh_index_after_mutation(root, record))
}

fn start_attempt(root: &Path, options: &Value) -> Result<Value, CliFailure> {
    let task_id = options::required(options, "task")?;
    let task = super::show::resolve_record(root, &task_id, Some("task"))?;
    let relative = task.relative.to_string_lossy().replace('\\', "/");
    let segments: Vec<_> = relative.split('/').collect();
    let work_id = match segments.as_slice() {
        ["work", work_id, "tasks", ..] => *work_id,
        _ => {
            return Err(CliFailure::new(
                "invalid_record_path",
                format!("Cannot infer work id for task: {task_id}"),
            ));
        }
    };
    let id = match options::optional(options, "id") {
        Some(id) => id.to_owned(),
        None => format!("A-{}", markdown::epoch_millis_string()?),
    };
    let title = options::optional(options, "title")
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Attempt {id}"));
    let path = root
        .join("work")
        .join(options::safe_id(work_id)?)
        .join("tasks")
        .join(options::safe_id(&task_id)?)
        .join("attempts")
        .join(format!("{}.md", options::safe_id(&id)?));
    if path.exists() {
        return Err(CliFailure::new(
            "record_exists",
            format!("Attempt already exists: {id}"),
        ));
    }
    let created = super::now_iso()?;
    let updated = super::now_iso()?;
    let mut metadata = serde_json::Map::new();
    for (key, value) in [
        ("schema", "project-ledger.attempt.v1".into()),
        ("kind", "attempt".into()),
        ("id", id.clone()),
        ("title", title),
        ("parentId", task_id),
        ("status", "started".into()),
        ("createdAt", created),
        ("updatedAt", updated),
    ] {
        metadata.insert(key.into(), Value::String(value));
    }
    metadata.extend(options::updates(
        options,
        &["validation", "review", "report"],
    )?);
    let body = options::body(options)?;
    markdown::create(&path, metadata, body.as_deref())?;
    let record = read_back(root, &path)?;
    markdown::append_event(
        root,
        &json!({
            "type":"attempt_started","id":id,"kind":"attempt","status":"started",
            "path":record.get("path").cloned().unwrap_or(Value::Null),"source":"project-ledger"
        }),
    )?;
    Ok(refresh_index_after_mutation(root, record))
}

fn update_attempt(root: &Path, options: &Value, target: &str) -> Result<Value, CliFailure> {
    let id = options::required(options, "id")?;
    let current = super::show::resolve_record(root, &id, Some("attempt"))?;
    let relative = current.relative.to_string_lossy().replace('\\', "/");
    let segments: Vec<_> = relative.split('/').collect();
    if !matches!(segments.as_slice(), ["work", _, "tasks", _, "attempts", ..]) {
        return Err(CliFailure::new(
            "invalid_record_path",
            format!("Cannot infer task id for attempt: {id}"),
        ));
    }
    state::transition("attempt", &current.record, target, &id)?;
    let mut updates = serde_json::Map::new();
    updates.insert("status".into(), Value::String(target.into()));
    updates.extend(options::updates(
        options,
        &["validation", "review", "report"],
    )?);
    let body = options::body(options)?;
    markdown::update(&current.path, &updates, body.as_deref())?;
    markdown::append_event(
        root,
        &json!({"type":format!("attempt_{target}"),"id":id,"source":"project-ledger"}),
    )?;
    let record = read_back(root, &current.path)?;
    Ok(refresh_index_after_mutation(root, record))
}

fn read_back(root: &Path, path: &Path) -> Result<Value, CliFailure> {
    super::show::read_record_path(root, path)?
        .map(|record| record.record)
        .ok_or_else(super::io_failure)
}
