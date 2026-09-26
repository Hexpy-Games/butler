//! Source external-effect-record-update choreography inside a private candidate.

use std::path::Path;

use serde_json::{Map, Value};

use super::{LedgerCommand, execute_candidate, show};
use crate::locale::LocaleCollation;
use crate::project_ledger::publication::{
    ProjectLedgerRecordKind, ProjectLedgerRecordOperation, ProjectLedgerRecordUpdate,
};

pub(in crate::project_ledger) fn apply(
    root: &Path,
    update: &ProjectLedgerRecordUpdate,
    collation: &LocaleCollation,
) -> Result<(), ()> {
    if update.operation == Some(ProjectLedgerRecordOperation::Create) {
        return create(root, update, collation);
    }
    let current = show::resolve_record(
        root,
        &update.id,
        update.kind.as_ref().map(ProjectLedgerRecordKind::as_str),
    )
    .map_err(|_| ())?;
    let kind = current
        .record
        .get("kind")
        .and_then(Value::as_str)
        .ok_or(())?;
    let mut options = options(update)?;
    options.insert("kind".into(), Value::String(kind.into()));
    if current.record.get("spec").is_some_and(truthy) && update.spec_exemption == Some(true) {
        options.shift_remove("spec-exemption");
    }
    let status = update.status.as_deref();
    if status.is_none() || !matches!(kind, "work" | "task" | "attempt") {
        return command(root, LedgerCommand::RecordUpdate, options, collation);
    }
    let status = status.ok_or(())?;
    let from = current
        .record
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("");
    let path = super::lifecycle::state::plan_transition_path(kind, from, status).map_err(|_| ())?;
    for step in path.iter().take(path.len().saturating_sub(1)) {
        let mut intermediate = Map::new();
        intermediate.insert("id".into(), Value::String(update.id.clone()));
        intermediate.insert("kind".into(), Value::String(kind.into()));
        intermediate.insert("status".into(), Value::String(step.clone()));
        command(root, LedgerCommand::RecordUpdate, intermediate, collation)?;
    }
    if !path.is_empty() || has_non_status(update) {
        options.insert("status".into(), Value::String(status.into()));
        command(root, LedgerCommand::RecordUpdate, options, collation)?;
    }
    Ok(())
}

fn create(
    root: &Path,
    update: &ProjectLedgerRecordUpdate,
    collation: &LocaleCollation,
) -> Result<(), ()> {
    let kind = update.kind.as_ref().ok_or(())?;
    if update.title.as_deref().is_none_or(str::is_empty) {
        return Err(());
    }
    let mut options = options(update)?;
    let command_kind = match kind {
        ProjectLedgerRecordKind::Work => LedgerCommand::WorkCreate,
        ProjectLedgerRecordKind::Task => {
            let parent = update.parent_id.as_deref().ok_or(())?;
            options.insert("work".into(), Value::String(parent.into()));
            LedgerCommand::TaskCreate
        }
        ProjectLedgerRecordKind::Attempt => {
            if update
                .status
                .as_deref()
                .is_some_and(|status| status != "started")
            {
                return Err(());
            }
            let parent = update.parent_id.as_deref().ok_or(())?;
            options.insert("task".into(), Value::String(parent.into()));
            LedgerCommand::AttemptStart
        }
        _ => LedgerCommand::RecordCreate,
    };
    command(root, command_kind, options, collation)?;
    if matches!(
        kind,
        ProjectLedgerRecordKind::Task | ProjectLedgerRecordKind::Attempt
    ) {
        let mut extras = Map::new();
        extras.insert("id".into(), Value::String(update.id.clone()));
        extras.insert("kind".into(), Value::String(kind.as_str().into()));
        for (field, value) in [
            ("spec", update.spec.as_ref()),
            ("acceptance", update.acceptance.as_ref()),
            ("implementation", update.implementation.as_ref()),
            ("mitigation", update.mitigation.as_ref()),
            ("reason", update.reason.as_ref()),
            ("code-commits", update.code_commits.as_ref()),
            ("ledger-commits", update.ledger_commits.as_ref()),
        ] {
            if let Some(value) = value {
                extras.insert(field.into(), Value::String(value.clone()));
            }
        }
        if update.requires_commit_evidence == Some(true) {
            extras.insert("requires-commit-evidence".into(), Value::Bool(true));
        }
        if extras.len() > 2 {
            command(root, LedgerCommand::RecordUpdate, extras, collation)?;
        }
    }
    Ok(())
}

fn options(update: &ProjectLedgerRecordUpdate) -> Result<Map<String, Value>, ()> {
    let mut value = serde_json::to_value(update).map_err(|_| ())?;
    let object = value.as_object_mut().ok_or(())?;
    object.shift_remove("operation");
    object.shift_remove("parentId");
    for (source, target) in [
        ("codeCommits", "code-commits"),
        ("ledgerCommits", "ledger-commits"),
        ("requiresCommitEvidence", "requires-commit-evidence"),
        ("specExemption", "spec-exemption"),
    ] {
        if let Some(value) = object.shift_remove(source)
            && value != Value::Bool(false)
        {
            object.insert(target.into(), value);
        }
    }
    Ok(object.clone())
}

fn has_non_status(update: &ProjectLedgerRecordUpdate) -> bool {
    update.title.is_some()
        || update.body.is_some()
        || update.spec.is_some()
        || update.acceptance.is_some()
        || update.validation.is_some()
        || update.review.is_some()
        || update.report.is_some()
        || update.implementation.is_some()
        || update.mitigation.is_some()
        || update.reason.is_some()
        || update.code_commits.is_some()
        || update.ledger_commits.is_some()
        || update.priority.is_some()
        || update.requires_commit_evidence.is_some()
        || update.spec_exemption.is_some()
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        _ => true,
    }
}

fn command(
    root: &Path,
    kind: LedgerCommand,
    options: Map<String, Value>,
    collation: &LocaleCollation,
) -> Result<(), ()> {
    let result = execute_candidate(root, kind, Value::Object(options), collation);
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(())
    }
}
