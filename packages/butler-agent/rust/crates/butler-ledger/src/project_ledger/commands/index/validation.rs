use std::collections::HashMap;

use serde_json::Value;

use super::records::issue;

pub(super) fn validate(record: &Value, by_id: &HashMap<&str, &Value>) -> Vec<Value> {
    let id = text(record, "id");
    let kind = text(record, "kind");
    let status = text(record, "status");
    let path = text(record, "path");
    let mut issues = Vec::new();
    if id.is_empty() || matches!(id, "work" | "project") {
        issues.push(issue(
            "invalid_schema",
            "error",
            "Record id is missing or too generic",
            path,
            Some(record),
        ));
    }
    let valid_states: &[&str] = match kind {
        "work" => &[
            "proposed",
            "scoped",
            "specified",
            "in_progress",
            "review",
            "done",
            "blocked",
            "cancelled",
        ],
        "task" => &[
            "todo",
            "in_progress",
            "done",
            "blocked",
            "failed",
            "cancelled",
        ],
        "attempt" => &["started", "succeeded", "failed", "interrupted"],
        _ => &[],
    };
    if !valid_states.is_empty() && !valid_states.contains(&status) {
        issues.push(issue(
            "invalid_state",
            "error",
            &format!("Invalid {kind} state: {status}"),
            path,
            Some(record),
        ));
    }
    let parent = text(record, "parentId");
    if kind == "task" && !parent.is_empty() && !by_id.contains_key(parent) {
        issues.push(issue(
            "orphan_task",
            "error",
            &format!("Task parent does not exist: {parent}"),
            path,
            Some(record),
        ));
    }
    if kind == "work"
        && !matches!(status, "done" | "cancelled")
        && text(record, "spec").is_empty()
        && !record
            .get("specExemption")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        issues.push(issue(
            "missing_spec",
            "warning",
            "Active work has no linked spec or spec exemption",
            path,
            Some(record),
        ));
    }
    if kind == "work" && status == "done" {
        for (field, available) in [
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
        ] {
            if !available {
                issues.push(issue(
                    "completion_gate",
                    "error",
                    &format!("Completed work is missing {field} evidence"),
                    path,
                    Some(record),
                ));
            }
        }
    }
    issues
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
