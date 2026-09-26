use serde_json::{Map, Value, json};
use std::collections::{HashSet, VecDeque};

use super::super::contracts::CliFailure;

pub(in crate::project_ledger) fn plan_transition_path(
    kind: &str,
    from: &str,
    to: &str,
) -> Result<Vec<String>, CliFailure> {
    if !states(kind).contains(&to) {
        let mut error = CliFailure::new("invalid_state", format!("Invalid {kind} state: {to}"));
        error.details = Box::new(json!([{"kind":kind,"status":to}]));
        error.next = states(kind)
            .iter()
            .map(|state| {
                json!({
                    "command":command(kind, "<id>", state, None),
                    "reason":format!("Use a valid {kind} state instead of {to}: {state}.")
                })
            })
            .collect();
        return Err(error);
    }
    if from.is_empty() || from == "unknown" {
        return Ok(vec![to.to_owned()]);
    }
    if from == to {
        return Ok(Vec::new());
    }
    let mut queue = VecDeque::from([vec![from]]);
    let mut visited = HashSet::from([from]);
    while let Some(path) = queue.pop_front() {
        let current = path[path.len() - 1];
        for &next in transitions(kind, current) {
            if !visited.insert(next) {
                continue;
            }
            let mut candidate = path.clone();
            candidate.push(next);
            if next == to {
                return Ok(candidate.into_iter().skip(1).map(str::to_owned).collect());
            }
            queue.push_back(candidate);
        }
    }
    let mut error = CliFailure::new(
        "invalid_transition",
        format!("Invalid {kind} transition: {from} -> {to}"),
    );
    error.details = Box::new(json!([{"kind":kind,"status":from}]));
    let allowed = transitions(kind, from);
    error.next = if kind == "task" && from == "todo" && to == "done" {
        vec![
            json!({"command":"project-ledger task update --id <id> --status in_progress","reason":"Move the task to in_progress first."}),
            json!({"command":"project-ledger task complete --id <id>","reason":"Retry completion after the task is in_progress."}),
        ]
    } else if allowed.is_empty() {
        vec![json!({
            "command":if kind == "attempt" { "project-ledger attempt start --task <task-id> --id <new-id>".to_owned() } else { format!("project-ledger {kind} create --id <id>") },
            "reason":format!("{kind} records in {from} cannot transition to {to}; create or choose an active record.")
        })]
    } else {
        allowed.iter().map(|state| json!({
            "command":command(kind, "<id>", state, None),
            "reason":format!("Transition {kind} from {from} to {state} before retrying {to}.")
        })).collect()
    };
    Err(error)
}

pub(super) fn valid_creation(
    kind: &str,
    status: &str,
    id: Option<&str>,
    work_id: Option<&str>,
) -> Result<(), CliFailure> {
    let valid = states(kind);
    if valid.contains(&status) {
        return Ok(());
    }
    let mut error = CliFailure::new("invalid_state", format!("Invalid {kind} state: {status}"));
    error.details = Box::new(match id {
        Some(id) => json!([{"id":id,"kind":kind,"status":status}]),
        None => json!([{"kind":kind,"status":status}]),
    });
    let id = id.unwrap_or("<id>");
    error.next = valid.iter().map(|valid_state| {
        let command = if kind == "task" {
            format!("project-ledger task create --work {} --id {id} --status {valid_state}", work_id.unwrap_or("<work-id>"))
        } else {
            format!("project-ledger work create --id {id} --status {valid_state}")
        };
        json!({"command":command,"reason":format!("Use a valid {kind} state instead of {status}: {valid_state}.")})
    }).collect();
    Err(error)
}

pub(super) fn transition(
    kind: &str,
    current: &Value,
    target: &str,
    id: &str,
) -> Result<(), CliFailure> {
    let valid = states(kind);
    let task_id = current.get("parentId").and_then(Value::as_str);
    if !valid.contains(&target) {
        let mut error = CliFailure::new("invalid_state", format!("Invalid {kind} state: {target}"));
        error.details = Box::new(json!([{"id":id,"kind":kind,"status":target}]));
        error.next = valid
            .iter()
            .map(|state| {
                json!({
                    "command": command(kind, id, state, task_id),
                    "reason":format!("Use a valid {kind} state instead of {target}: {state}.")
                })
            })
            .collect();
        return Err(error);
    }
    let from = current
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if from.is_empty() || from == "unknown" || from == target {
        return Ok(());
    }
    let allowed = transitions(kind, from);
    if allowed.contains(&target) {
        return Ok(());
    }
    let mut error = CliFailure::new(
        "invalid_transition",
        format!("Invalid {kind} transition: {from} -> {target}"),
    );
    error.details = Box::new(json!([{"id":id,"kind":kind,"status":from}]));
    error.next = if kind == "task" && from == "todo" && target == "done" {
        vec![
            json!({"command":format!("project-ledger task update --id {id} --status in_progress"),"reason":"Move the task to in_progress first."}),
            json!({"command":format!("project-ledger task complete --id {id}"),"reason":"Retry completion after the task is in_progress."}),
        ]
    } else if allowed.is_empty() {
        vec![json!({
            "command":if kind == "attempt" { format!("project-ledger attempt start --task {} --id {id}", current.get("parentId").and_then(Value::as_str).unwrap_or("<task-id>")) } else { format!("project-ledger {kind} create --id {id}") },
            "reason":format!("{kind} records in {from} cannot transition to {target}; create or choose an active record.")
        })]
    } else {
        allowed.iter().map(|state| json!({
            "command":command(kind, id, state, task_id),
            "reason":format!("Transition {kind} from {from} to {state} before retrying {target}.")
        })).collect()
    };
    Err(error)
}

pub(super) fn work_completion_gate(
    current: &Value,
    updates: &Map<String, Value>,
) -> Result<(), CliFailure> {
    let id = current.get("id").and_then(Value::as_str).unwrap_or("<id>");
    let value = |key: &str| updates.get(key).or_else(|| current.get(key));
    let truthy = |key: &str| value(key).is_some_and(js_truthy);
    let mut missing = Vec::new();
    if !truthy("spec") && !truthy("specExemption") {
        missing.push("spec");
    }
    if !truthy("acceptance") && !truthy("acceptanceExemption") {
        missing.push("acceptance");
    }
    for key in ["validation", "review", "report"] {
        if !truthy(key) {
            missing.push(key);
        }
    }
    if truthy("requiresCommitEvidence") && !has_code_commit_evidence(value("codeCommits")) {
        missing.push("codeCommits");
    }
    if missing.is_empty() {
        return Ok(());
    }
    let mut error = CliFailure::new(
        "completion_gate_failed",
        format!("Work completion gate failed: {}", missing.join(", ")),
    );
    error.details = Box::new(Value::Array(
        missing
            .iter()
            .map(|field| {
                json!({
                    "code":format!("missing_{field}"),
                    "field":field,
                    "message":format!("Completed work is missing {field} evidence"),
                    "next":[completion_hint(field,id)]
                })
            })
            .collect(),
    ));
    error.next = missing
        .iter()
        .map(|field| completion_hint(field, id))
        .collect();
    Err(error)
}

fn has_code_commit_evidence(value: Option<&Value>) -> bool {
    let Some(text) = value.and_then(Value::as_str) else {
        return false;
    };
    if crate::public_text::trim_js_whitespace(text).is_empty() {
        return false;
    }
    let Ok(Value::Array(commits)) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    commits.iter().any(|commit| {
        ["repo", "hash", "message"].iter().all(|key| {
            commit
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|value| !crate::public_text::trim_js_whitespace(value).is_empty())
        })
    })
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value
            .as_f64()
            .is_some_and(|value| value != 0.0 && !value.is_nan()),
        _ => true,
    }
}

fn completion_hint(field: &str, id: &str) -> Value {
    let flag = match field {
        "spec" => "--spec SPEC-ID or --spec-exemption",
        "acceptance" => "--acceptance TEXT or --acceptance-exemption",
        "validation" => "--validation TEXT",
        "review" => "--review TEXT",
        "report" => "--report PATH",
        "codeCommits" => "--code-commits JSON or --code-commit auto",
        _ => "--field VALUE",
    };
    json!({"command":format!("project-ledger work complete --id {id} {flag}"),"reason":format!("Provide {field} evidence before completing the work.")})
}

fn command(kind: &str, id: &str, state: &str, task_id: Option<&str>) -> String {
    match (kind, state) {
        ("work", "done") => format!("project-ledger work complete --id {id}"),
        ("task", "done") => format!("project-ledger task complete --id {id}"),
        ("attempt", "succeeded") => format!("project-ledger attempt succeed --id {id}"),
        ("attempt", "failed") => format!("project-ledger attempt fail --id {id}"),
        ("attempt", "started") => {
            format!(
                "project-ledger attempt start --task {} --id {id}",
                task_id.unwrap_or("<task-id>")
            )
        }
        _ => format!("project-ledger {kind} update --id {id} --status {state}"),
    }
}

fn states(kind: &str) -> &'static [&'static str] {
    match kind {
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
    }
}

fn transitions(kind: &str, from: &str) -> &'static [&'static str] {
    match (kind, from) {
        ("work", "proposed") => &["scoped", "blocked", "cancelled"],
        ("work", "scoped") => &["specified", "in_progress", "blocked", "cancelled"],
        ("work", "specified") => &["in_progress", "review", "blocked", "cancelled"],
        ("work", "in_progress") => &["review", "blocked", "cancelled"],
        ("work", "review") => &["done", "in_progress", "blocked", "cancelled"],
        ("work", "blocked") => &["in_progress", "cancelled"],
        ("task", "todo") => &["in_progress", "blocked", "cancelled"],
        ("task", "in_progress") => &["done", "failed", "blocked", "cancelled"],
        ("task", "blocked" | "failed") => &["in_progress", "cancelled"],
        ("attempt", "started") => &["succeeded", "failed", "interrupted"],
        _ => &[],
    }
}
