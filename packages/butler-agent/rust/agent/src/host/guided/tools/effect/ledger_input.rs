//! Source guided-project-ledger-effect-input: one reviewed record update.

use serde_json::{Map, Value};

use crate::btcc::BtccError;
use crate::public_text::trim_js_whitespace;

pub(super) fn managed(name: &str) -> bool {
    matches!(
        name,
        "project_ledger_create"
            | "project_ledger_update"
            | "project_ledger_work_update"
            | "project_ledger_task_update"
            | "project_ledger_task_complete"
            | "project_ledger_attempt_succeed"
            | "project_ledger_attempt_fail"
    )
}

pub(super) fn prepare(
    name: &str,
    args: &Map<String, Value>,
    project_id: &str,
) -> Result<(String, Value), BtccError> {
    if !managed(name) {
        return Err(invalid("Project Ledger effect adapter is unavailable"));
    }
    let explicit =
        optional_string(args, "project_ref").or_else(|| optional_string(args, "project_path"));
    if explicit.is_some_and(|reference| reference != project_id) {
        return Err(invalid(
            "Project Ledger mutation target differs from the active project. Omit project_ref or use the active project.",
        ));
    }
    let create = name == "project_ledger_create";
    let id = required_string(args, "id")?;
    let kind = match name {
        "project_ledger_work_update" => "work".to_owned(),
        "project_ledger_task_update" | "project_ledger_task_complete" => "task".to_owned(),
        "project_ledger_attempt_succeed" | "project_ledger_attempt_fail" => "attempt".to_owned(),
        _ => required_string(args, "kind")?.to_owned(),
    };
    let mut update = Map::new();
    update.insert(
        "operation".into(),
        Value::String(if create { "create" } else { "update" }.into()),
    );
    update.insert("id".into(), Value::String(id.to_owned()));
    update.insert("kind".into(), Value::String(kind.clone()));
    if create {
        update.insert(
            "title".into(),
            Value::String(required_string(args, "title")?.to_owned()),
        );
        if let Some(parent) =
            optional_string(args, "work_id").or_else(|| optional_string(args, "task_id"))
        {
            update.insert("parentId".into(), Value::String(parent.to_owned()));
        }
    }
    for (source, field) in [
        ("title", "title"),
        ("status", "status"),
        ("body", "body"),
        ("spec", "spec"),
        ("validation", "validation"),
        ("review", "review"),
        ("report", "report"),
        ("implementation", "implementation"),
        ("mitigation", "mitigation"),
        ("reason", "reason"),
        ("code_commits", "codeCommits"),
        ("ledger_commits", "ledgerCommits"),
    ] {
        if let Some(text) = optional_string(args, source) {
            update.insert(field.into(), Value::String(text.to_owned()));
        }
    }
    if let Some(acceptance) = acceptance(args.get("acceptance")) {
        update.insert("acceptance".into(), Value::String(acceptance));
    }
    if let Some(priority) = args
        .get("priority")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
    {
        update.insert("priority".into(), Value::from(priority));
    }
    for (source, field) in [
        ("requires_commit_evidence", "requiresCommitEvidence"),
        ("spec_exemption", "specExemption"),
    ] {
        if let Some(value) = args.get(source).and_then(Value::as_bool) {
            update.insert(field.into(), Value::Bool(value));
        }
    }
    if create && kind == "work" && !update.contains_key("spec") {
        update.insert("specExemption".into(), Value::Bool(true));
    }
    match name {
        "project_ledger_task_complete" => {
            update.insert("status".into(), Value::String("done".into()))
        }
        "project_ledger_attempt_succeed" => {
            update.insert("status".into(), Value::String("succeeded".into()))
        }
        "project_ledger_attempt_fail" => {
            update.insert("status".into(), Value::String("failed".into()))
        }
        _ => None,
    };
    Ok((format!("project-ledger:{kind}:{id}"), Value::Object(update)))
}

fn acceptance(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => nonempty(text).map(str::to_owned),
        Value::Array(items) if !items.is_empty() => {
            let lines = items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(nonempty)
                .collect::<Vec<_>>();
            (!lines.is_empty()).then(|| lines.join("\n"))
        }
        _ => None,
    }
}

fn optional_string<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).and_then(nonempty)
}

fn required_string<'a>(args: &'a Map<String, Value>, key: &str) -> Result<&'a str, BtccError> {
    optional_string(args, key)
        .ok_or_else(|| invalid(&format!("Project Ledger effect requires {key}")))
}

fn nonempty(text: &str) -> Option<&str> {
    let trimmed = trim_js_whitespace(text);
    (!trimmed.is_empty()).then_some(trimmed)
}

fn invalid(message: &str) -> BtccError {
    BtccError::relayed("project_ledger_effect_input_invalid", message)
}
