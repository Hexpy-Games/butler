//! Source generic record creation and update under the Ledger mutation claim.

use std::path::Path;

use serde_json::{Map, Value, json};

use super::{markdown, options, state};
use crate::project_ledger::commands::contracts::CliFailure;

const ALL_METADATA: &[&str] = &[
    "title",
    "status",
    "spec",
    "parentId",
    "validation",
    "review",
    "report",
    "implementation",
    "mitigation",
    "reason",
    "acceptance",
    "codeCommits",
    "ledgerCommits",
    "revisionRef",
    "logicalId",
    "concernId",
    "supersedesSpecId",
];

pub(super) fn create_top_level(root: &Path, args: &Value) -> Result<Value, CliFailure> {
    let kind = options::required(args, "kind")?;
    let directory = match kind.as_str() {
        "initiative" => "initiatives",
        "decision" => "decisions",
        "risk" => "risks",
        "spec" => "specs",
        "report" => "reports",
        "plan" => "plans",
        "handoff" => "handoffs",
        "reference" => "references",
        "roadmap" => "roadmaps",
        _ => {
            return Err(CliFailure::new(
                "invalid_input",
                format!("Unsupported record kind: {kind}"),
            ));
        }
    };
    let id = options::required(args, "id")?;
    let title = options::required(args, "title")?;
    let status = options::optional(args, "status").unwrap_or(match kind.as_str() {
        "decision" => "accepted",
        "risk" => "open",
        "report" => "done",
        "plan" => "active",
        _ => "active",
    });
    let timestamp = super::super::now_iso()?;
    let mut metadata = base(&kind, &id, &title, status, &timestamp);
    metadata.extend(options::updates(args, ALL_METADATA)?);
    let safe_id = options::safe_id(&id)?.to_lowercase();
    let path = root.join(directory).join(format!("{safe_id}.md"));
    create_record(
        root,
        &path,
        &kind,
        &id,
        metadata,
        args,
        &format!("{kind}_created"),
    )
}

pub(super) fn create_work(root: &Path, args: &Value) -> Result<Value, CliFailure> {
    let status = options::optional(args, "status").unwrap_or("proposed");
    let optional_id = options::optional(args, "id");
    state::valid_creation("work", status, optional_id, None)?;
    let id = options::required(args, "id")?;
    let title = options::required(args, "title")?;
    let created = super::super::now_iso()?;
    let updated = super::super::now_iso()?;
    let mut metadata = base_with_times("work", &id, &title, status, &created, &updated);
    metadata.extend(options::updates(
        args,
        &[
            "spec",
            "acceptance",
            "validation",
            "review",
            "report",
            "implementation",
            "mitigation",
            "codeCommits",
            "ledgerCommits",
        ],
    )?);
    let path = root
        .join("work")
        .join(options::safe_id(&id)?)
        .join("work.md");
    create_record(root, &path, "work", &id, metadata, args, "work_created")
}

pub(super) fn create_task(root: &Path, args: &Value) -> Result<Value, CliFailure> {
    let work_id = options::required(args, "work")?;
    super::super::show::resolve_record(root, &work_id, Some("work"))?;
    let status = options::optional(args, "status").unwrap_or("todo");
    let optional_id = options::optional(args, "id");
    state::valid_creation("task", status, optional_id, Some(&work_id))?;
    let id = options::required(args, "id")?;
    let title = options::required(args, "title")?;
    let created = super::super::now_iso()?;
    let updated = super::super::now_iso()?;
    let mut metadata = base_with_times("task", &id, &title, status, &created, &updated);
    metadata.insert("parentId".into(), work_id.clone().into());
    metadata.extend(options::updates(args, &["validation", "review", "report"])?);
    let path = root
        .join("work")
        .join(options::safe_id(&work_id)?)
        .join("tasks")
        .join(format!("{}.md", options::safe_id(&id)?));
    create_record(root, &path, "task", &id, metadata, args, "task_created")
}

pub(super) fn update_generic(root: &Path, args: &Value) -> Result<Value, CliFailure> {
    let id = options::required(args, "id")?;
    let current = super::super::show::resolve_record(root, &id, options::optional(args, "kind"))?;
    let kind = current
        .record
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("record");
    if !matches!(
        kind,
        "initiative"
            | "decision"
            | "risk"
            | "spec"
            | "report"
            | "plan"
            | "handoff"
            | "reference"
            | "roadmap"
            | "work"
            | "task"
            | "attempt"
    ) {
        return Err(CliFailure::new(
            "invalid_input",
            format!("Record kind does not support generic update: {kind}"),
        ));
    }
    let updates = options::updates(args, ALL_METADATA)?;
    let body = options::body(args)?;
    if updates.is_empty() && body.is_none() {
        return Err(CliFailure::new(
            "invalid_input",
            "record update requires --from or at least one metadata flag",
        ));
    }
    if let Some(status) = updates.get("status").and_then(Value::as_str)
        && matches!(kind, "work" | "task" | "attempt")
    {
        state::transition(kind, &current.record, status, &id)?;
        if kind == "work" && status == "done" {
            state::work_completion_gate(&current.record, &updates)?;
        }
    }
    markdown::update(&current.path, &updates, body.as_deref())?;
    let event = json!({
        "type":format!("{kind}_updated"),"id":id,"kind":kind,
        "path":current.record.get("path").cloned().unwrap_or(Value::Null),
        "source":"project-ledger"
    });
    markdown::append_event(root, &event)?;
    let record = super::read_back(root, &current.path)?;
    Ok(super::super::refresh_index_after_mutation(root, record))
}

fn create_record(
    root: &Path,
    path: &Path,
    kind: &str,
    id: &str,
    metadata: Map<String, Value>,
    args: &Value,
    event_type: &str,
) -> Result<Value, CliFailure> {
    if path.exists() {
        let label = match kind {
            "work" => "Work",
            "task" => "Task",
            _ => kind,
        };
        return Err(CliFailure::new(
            "record_exists",
            format!("{label} already exists: {id}"),
        ));
    }
    let body = options::body(args)?;
    let status = metadata.get("status").cloned().unwrap_or(Value::Null);
    markdown::create(path, metadata, body.as_deref())?;
    let record = super::read_back(root, path)?;
    let event = json!({
        "type":event_type,"id":id,"kind":kind,"status":status,
        "path":record.get("path").cloned().unwrap_or(Value::Null),
        "source":"project-ledger"
    });
    markdown::append_event(root, &event)?;
    Ok(super::super::refresh_index_after_mutation(root, record))
}

fn base(kind: &str, id: &str, title: &str, status: &str, timestamp: &str) -> Map<String, Value> {
    base_with_times(kind, id, title, status, timestamp, timestamp)
}

fn base_with_times(
    kind: &str,
    id: &str,
    title: &str,
    status: &str,
    created: &str,
    updated: &str,
) -> Map<String, Value> {
    let mut metadata = Map::new();
    for (key, value) in [
        ("schema", format!("project-ledger.{kind}.v1")),
        ("kind", kind.to_owned()),
        ("id", id.to_owned()),
        ("title", title.to_owned()),
        ("status", status.to_owned()),
        ("createdAt", created.to_owned()),
        ("updatedAt", updated.to_owned()),
    ] {
        metadata.insert(key.into(), Value::String(value));
    }
    metadata
}
