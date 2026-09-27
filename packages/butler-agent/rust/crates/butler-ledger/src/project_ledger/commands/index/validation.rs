use std::collections::HashMap;

use serde_json::Value;

use super::records::issue;
use crate::project_ledger::status::Lifecycle;

/// The index issues one record raises: generic ids, invalid lifecycle
/// states, orphan tasks, active Work without a spec, and completed Work
/// missing evidence.
pub(super) fn validate(record: &Value, by_id: &HashMap<&str, &Value>) -> Vec<Value> {
    let id = text(record, "id");
    let kind = text(record, "kind");
    let status = text(record, "status");
    let path = text(record, "path");
    let mut issues = Vec::new();
    let mut raise = |code: &str, severity: &str, message: &str| {
        issues.push(issue(code, severity, message, path, Some(record)));
    };
    if id.is_empty() || matches!(id, "work" | "project") {
        raise(
            "invalid_schema",
            "error",
            "Record id is missing or too generic",
        );
    }
    if Lifecycle::parse(kind).is_some_and(|lifecycle| lifecycle.status(status).is_none()) {
        raise(
            "invalid_state",
            "error",
            &format!("Invalid {kind} state: {status}"),
        );
    }
    let parent = text(record, "parentId");
    if kind == "task" && !parent.is_empty() && !by_id.contains_key(parent) {
        raise(
            "orphan_task",
            "error",
            &format!("Task parent does not exist: {parent}"),
        );
    }
    if kind == "work"
        && !matches!(status, "done" | "cancelled")
        && text(record, "spec").is_empty()
        && !record
            .get("specExemption")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        raise(
            "missing_spec",
            "warning",
            "Active work has no linked spec or spec exemption",
        );
    }
    if kind == "work" && status == "done" {
        for field in missing_evidence(record) {
            raise(
                "completion_gate",
                "error",
                &format!("Completed work is missing {field} evidence"),
            );
        }
    }
    issues
}

/// The evidence fields completed Work lacks, in gate order.
fn missing_evidence(record: &Value) -> Vec<&'static str> {
    [
        (
            "spec",
            !text(record, "spec").is_empty() || truthy(record, "specExemption"),
        ),
        (
            "acceptance",
            !text(record, "acceptance").is_empty() || truthy(record, "acceptanceExemption"),
        ),
        ("validation", !text(record, "validation").is_empty()),
        ("review", !text(record, "review").is_empty()),
        ("report", !text(record, "report").is_empty()),
        (
            "codeCommits",
            !truthy(record, "requiresCommitEvidence") || code_commit_evidence(record),
        ),
    ]
    .into_iter()
    .filter_map(|(field, available)| (!available).then_some(field))
    .collect()
}

fn text<'a>(record: &'a Value, field: &str) -> &'a str {
    record.get(field).and_then(Value::as_str).unwrap_or("")
}

fn truthy(record: &Value, field: &str) -> bool {
    record.get(field).and_then(Value::as_bool).unwrap_or(false)
}

fn code_commit_evidence(record: &Value) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(text(record, "codeCommits")) else {
        return false;
    };
    value.as_array().is_some_and(|commits| {
        commits.iter().any(|commit| {
            ["repo", "hash", "message"].iter().all(|field| {
                commit
                    .get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty())
            })
        })
    })
}
