//! Lifecycle status checks for Ledger commands, with the source's error
//! details and next-command hints.

use serde_json::{Map, Value, json};
use std::collections::{HashSet, VecDeque};

use super::super::contracts::CliFailure;
use crate::project_ledger::status::{Lifecycle, Status};

/// The statuses to pass through, in order, to move a `kind` record from
/// `from` to `to` one allowed transition at a time; `None` when `to` is not
/// a status of the kind or cannot be reached.
pub(in crate::project_ledger) fn plan_transition_path(
    kind: Lifecycle,
    from: &str,
    to: &str,
) -> Option<Vec<Status>> {
    let to = kind.status(to)?;
    if from.is_empty() || from == "unknown" {
        return Some(vec![to]);
    }
    if from == to.as_str() {
        return Some(Vec::new());
    }
    let from = kind.status(from)?;
    let mut queue = VecDeque::from([vec![from]]);
    let mut visited = HashSet::from([from]);
    while let Some(path) = queue.pop_front() {
        let current = *path.last()?;
        for &next in kind.transitions(current) {
            if !visited.insert(next) {
                continue;
            }
            let mut candidate = path.clone();
            candidate.push(next);
            if next == to {
                return Some(candidate.into_iter().skip(1).collect());
            }
            queue.push_back(candidate);
        }
    }
    None
}

/// A record is created in one of its kind's statuses.
pub(super) fn valid_creation(
    kind: Lifecycle,
    status: &str,
    id: Option<&str>,
    work_id: Option<&str>,
) -> Result<(), CliFailure> {
    if kind.status(status).is_some() {
        return Ok(());
    }
    let name = kind.name();
    let mut error = CliFailure::new("invalid_state", format!("Invalid {name} state: {status}"));
    error.details = Box::new(match id {
        Some(id) => json!([{"id":id,"kind":name,"status":status}]),
        None => json!([{"kind":name,"status":status}]),
    });
    let id = id.unwrap_or("<id>");
    error.next = kind
        .states()
        .iter()
        .map(|valid| {
            let valid = valid.as_str();
            let command = if kind == Lifecycle::Task {
                format!(
                    "project-ledger task create --work {} --id {id} --status {valid}",
                    work_id.unwrap_or("<work-id>")
                )
            } else {
                format!("project-ledger work create --id {id} --status {valid}")
            };
            json!({"command":command,"reason":format!("Use a valid {name} state instead of {status}: {valid}.")})
        })
        .collect();
    Err(error)
}

/// `current` may move to `target` directly (or already has it).
pub(super) fn transition(
    kind: Lifecycle,
    current: &Value,
    target: &str,
    id: &str,
) -> Result<(), CliFailure> {
    let task_id = current.get("parentId").and_then(Value::as_str);
    let Some(target_status) = kind.status(target) else {
        return Err(invalid_state(kind, target, id, task_id));
    };
    let from = current
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if from.is_empty() || from == "unknown" || from == target {
        return Ok(());
    }
    let allowed = kind
        .status(from)
        .map_or(&[][..], |from| kind.transitions(from));
    if allowed.contains(&target_status) {
        return Ok(());
    }
    let name = kind.name();
    let mut error = CliFailure::new(
        "invalid_transition",
        format!("Invalid {name} transition: {from} -> {target}"),
    );
    error.details = Box::new(json!([{"id":id,"kind":name,"status":from}]));
    error.next = transition_hints(kind, current, from, target, id, allowed);
    Err(error)
}

fn invalid_state(kind: Lifecycle, target: &str, id: &str, task_id: Option<&str>) -> CliFailure {
    let name = kind.name();
    let mut error = CliFailure::new("invalid_state", format!("Invalid {name} state: {target}"));
    error.details = Box::new(json!([{"id":id,"kind":name,"status":target}]));
    error.next = kind
        .states()
        .iter()
        .map(|state| {
            json!({
                "command": command(kind, id, *state, task_id),
                "reason":format!("Use a valid {name} state instead of {target}: {}.", state.as_str())
            })
        })
        .collect();
    error
}

/// What to run instead of a disallowed move.
fn transition_hints(
    kind: Lifecycle,
    current: &Value,
    from: &str,
    target: &str,
    id: &str,
    allowed: &[Status],
) -> Vec<Value> {
    let name = kind.name();
    if kind == Lifecycle::Task && from == "todo" && target == "done" {
        return vec![
            json!({"command":format!("project-ledger task update --id {id} --status in_progress"),"reason":"Move the task to in_progress first."}),
            json!({"command":format!("project-ledger task complete --id {id}"),"reason":"Retry completion after the task is in_progress."}),
        ];
    }
    let task_id = current.get("parentId").and_then(Value::as_str);
    if allowed.is_empty() {
        let command = if kind == Lifecycle::Attempt {
            format!(
                "project-ledger attempt start --task {} --id {id}",
                task_id.unwrap_or("<task-id>")
            )
        } else {
            format!("project-ledger {name} create --id {id}")
        };
        return vec![json!({
            "command":command,
            "reason":format!("{name} records in {from} cannot transition to {target}; create or choose an active record.")
        })];
    }
    allowed
        .iter()
        .map(|state| {
            json!({
                "command":command(kind, id, *state, task_id),
                "reason":format!("Transition {name} from {from} to {} before retrying {target}.", state.as_str())
            })
        })
        .collect()
}

/// Completed Work carries spec, acceptance, validation, review and report
/// evidence, and commit evidence when it requires it.
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
    if butler_core::public_text::trim_js_whitespace(text).is_empty() {
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
                .is_some_and(|value| {
                    !butler_core::public_text::trim_js_whitespace(value).is_empty()
                })
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

/// The command that moves a `kind` record to `state`.
fn command(kind: Lifecycle, id: &str, state: Status, task_id: Option<&str>) -> String {
    match (kind, state) {
        (Lifecycle::Work, Status::Done) => format!("project-ledger work complete --id {id}"),
        (Lifecycle::Task, Status::Done) => format!("project-ledger task complete --id {id}"),
        (Lifecycle::Attempt, Status::Succeeded) => {
            format!("project-ledger attempt succeed --id {id}")
        }
        (Lifecycle::Attempt, Status::Failed) => format!("project-ledger attempt fail --id {id}"),
        (Lifecycle::Attempt, Status::Started) => {
            format!(
                "project-ledger attempt start --task {} --id {id}",
                task_id.unwrap_or("<task-id>")
            )
        }
        _ => format!(
            "project-ledger {} update --id {id} --status {}",
            kind.name(),
            state.as_str()
        ),
    }
}
