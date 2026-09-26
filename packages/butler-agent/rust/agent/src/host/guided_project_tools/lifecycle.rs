//! Source task/work completion planning and durable Ledger closeout.

use std::path::Path;

use serde_json::{Map, Value, json};

use super::command;
use crate::project_ledger::{LedgerCommand, NativeProjectLedger, ProjectLedgerReadError};

mod closeout;
pub(super) use closeout::closeout;

/// Returns `None` for tools with no planned lifecycle transition.
pub(super) async fn execute(
    ledger: &NativeProjectLedger,
    root: &Path,
    name: &str,
    args: &Map<String, Value>,
    final_command: LedgerCommand,
    final_options: Value,
) -> Result<Option<Value>, ProjectLedgerReadError> {
    let kind = match name {
        "project_ledger_task_complete" => "task",
        "project_ledger_work_complete" => "work",
        _ => return Ok(None),
    };
    let id = text(args.get("id")).to_owned();
    // One replan is allowed when a transition races a concurrent status change.
    let mut refreshes = 0;
    'replan: loop {
        let shown = command(
            ledger,
            root,
            LedgerCommand::Show,
            json!({"kind":kind,"id":id}),
        )
        .await?;
        if shown.get("ok") != Some(&Value::Bool(true)) {
            return Ok(Some(with_refreshes(shown, refreshes)));
        }
        let status = shown
            .pointer("/data/status")
            .and_then(Value::as_str)
            .unwrap_or("");
        if status == "done" {
            return Ok(Some(completed(name, shown, args, &id, refreshes)));
        }
        if kind == "work" {
            let missing = missing_work_evidence(&shown, args);
            if !missing.is_empty() {
                return Ok(Some(with_refreshes(work_gate(&id, &missing), refreshes)));
            }
        }
        let statuses: &[&str] = if kind == "task" {
            if matches!(status, "todo" | "blocked" | "failed") {
                &["in_progress"]
            } else {
                &[]
            }
        } else {
            match status {
                "proposed" => &["scoped", "in_progress", "review"],
                "scoped" | "blocked" | "specified" => &["in_progress", "review"],
                "in_progress" => &["review"],
                _ => &[],
            }
        };
        let mut executed = Vec::with_capacity(statuses.len() + 1);
        for next in statuses {
            let updated = command(
                ledger,
                root,
                if kind == "work" {
                    LedgerCommand::WorkUpdate
                } else {
                    LedgerCommand::TaskUpdate
                },
                json!({"id":id,"status":next}),
            )
            .await?;
            executed.push(json!({"command":format!("{kind} update --id {id} --status {next}")}));
            if updated.get("ok") != Some(&Value::Bool(true)) {
                if refreshes == 0 && error_code(&updated) == "invalid_transition" {
                    refreshes += 1;
                    continue 'replan;
                }
                return Ok(Some(with_plan(recoverable(updated), executed, refreshes)));
            }
        }
        let result = command(ledger, root, final_command, final_options.clone()).await?;
        executed.push(json!({"command":final_summary(kind, &id, args)}));
        let result = with_plan(recoverable(result), executed, refreshes);
        if refreshes == 0 && error_code(&result) == "invalid_transition" {
            refreshes += 1;
            continue;
        }
        return Ok(Some(result));
    }
}

/// Successful lifecycle mutations retain their result; failed derived views retain it under mutation_result.
fn missing_work_evidence(current: &Value, args: &Map<String, Value>) -> Vec<&'static str> {
    let data = current.get("data").unwrap_or(&Value::Null);
    let mut missing = Vec::new();
    if text(args.get("spec")).is_empty()
        && text(data.get("spec")).is_empty()
        && data.get("specExemption") != Some(&Value::Bool(true))
    {
        missing.push("spec");
    }
    if text(args.get("acceptance")).is_empty()
        && text(data.get("acceptance")).is_empty()
        && data.get("acceptanceExemption") != Some(&Value::Bool(true))
    {
        missing.push("acceptance");
    }
    for field in ["validation", "review", "report"] {
        if text(args.get(field)).is_empty() && text(data.get(field)).is_empty() {
            missing.push(field);
        }
    }
    if data.get("requiresCommitEvidence") == Some(&Value::Bool(true))
        && text(args.get("code_commit")) != "auto"
        && !has_commit(args.get("code_commits"))
        && !has_commit(data.get("codeCommits"))
    {
        missing.push("codeCommits");
    }
    missing
}

fn has_commit(value: Option<&Value>) -> bool {
    serde_json::from_str::<Value>(text(value))
        .ok()
        .and_then(|value| value.as_array().cloned())
        .is_some_and(|items| {
            items.iter().any(|item| {
                ["repo", "hash", "message"]
                    .iter()
                    .all(|key| !text(item.get(*key)).is_empty())
            })
        })
}

fn work_gate(id: &str, missing: &[&str]) -> Value {
    json!({"ok":false,"recoverable":true,"error":{
        "code":"completion_gate_failed","message":format!("Work completion gate failed: {}",missing.join(", ")),
        "details":missing.iter().map(|field| json!({"code":format!("missing_{field}"),"field":field,"message":format!("Completed work is missing {field} evidence")})).collect::<Vec<_>>(),
        "native_next":[{"tool":"project_ledger_work_complete","args":{"id":id},"reason":"Provide missing completion evidence before completing the work."}],
    }})
}

fn completed(
    name: &str,
    current: Value,
    args: &Map<String, Value>,
    id: &str,
    refreshes: usize,
) -> Value {
    let data = current.get("data").unwrap_or(&Value::Null);
    let mut matches = ["validation", "review", "report"].iter().all(|key| {
        !text(args.get(*key)).is_empty() && text(args.get(*key)) == text(data.get(*key))
    });
    if name == "project_ledger_work_complete" {
        matches &= text(args.get("acceptance")).is_empty()
            || text(args.get("acceptance")) == text(data.get("acceptance"));
        matches &= data.get("requiresCommitEvidence") != Some(&Value::Bool(true))
            || (!text(args.get("code_commits")).is_empty()
                && text(args.get("code_commits")) == text(data.get("codeCommits")));
    }
    matches &= text(args.get("body")).is_empty() && text(args.get("code_commit")).is_empty();
    matches &= [
        ("code_commits", "codeCommits"),
        ("ledger_commits", "ledgerCommits"),
    ]
    .iter()
    .all(|(arg, field)| {
        text(args.get(*arg)).is_empty() || text(args.get(*arg)) == text(data.get(*field))
    });
    if matches {
        return with_plan(current, vec![], refreshes);
    }
    with_plan(
        json!({"ok":false,"recoverable":true,"error":{
            "code":"already_completed","message":"Project Ledger record is already completed and supplied closeout evidence does not match the current record.",
            "details":[{"id":id,"tool":name,"status":"done"}],
            "native_next":[{"tool":"project_ledger_show","args":{"id":id},"reason":"Inspect the completed record before deciding whether a metadata update is required."}],
        }}),
        vec![],
        refreshes,
    )
}

fn with_plan(mut result: Value, executed: Vec<Value>, refreshes: usize) -> Value {
    result["project_ledger_transition_plan"] = json!({"executed":executed,"refreshes":refreshes});
    result
}
fn with_refreshes(mut result: Value, refreshes: usize) -> Value {
    let mut plan = result
        .get("project_ledger_transition_plan")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    plan.insert("refreshes".into(), json!(refreshes));
    result["project_ledger_transition_plan"] = Value::Object(plan);
    result
}
fn error_code(result: &Value) -> &str {
    result
        .pointer("/error/code")
        .and_then(Value::as_str)
        .unwrap_or("")
}
fn text(value: Option<&Value>) -> &str {
    value
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .unwrap_or("")
}
fn nonempty(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
}
fn final_summary(kind: &str, id: &str, args: &Map<String, Value>) -> String {
    let mut words = vec![kind.to_owned(), "complete".into(), "--id".into(), id.into()];
    for (field, flag) in [
        ("title", "title"),
        ("status", "status"),
        ("spec", "spec"),
        ("validation", "validation"),
        ("review", "review"),
        ("report", "report"),
        ("code_commits", "code-commits"),
        ("code_commit", "code-commit"),
        ("ledger_commits", "ledger-commits"),
        ("acceptance", "acceptance"),
        ("implementation", "implementation"),
        ("mitigation", "mitigation"),
    ] {
        if let Some(value) = nonempty(args.get(field)) {
            words.extend([format!("--{flag}"), value.into()]);
        }
    }
    if args.get("requires_commit_evidence") == Some(&Value::Bool(true)) {
        words.push("--requires-commit-evidence".into());
    }
    if let Some(number) = args
        .get("priority")
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
    {
        words.extend(["--priority".into(), number.to_string()]);
    }
    words.join(" ")
}

fn recoverable(mut result: Value) -> Value {
    if result.get("ok") != Some(&Value::Bool(false)) {
        return result;
    }
    if matches!(
        error_code(&result),
        "invalid_input"
            | "invalid_arguments"
            | "invalid_state"
            | "invalid_transition"
            | "completion_gate_failed"
    ) {
        result["recoverable"] = Value::Bool(true);
    }
    result
}
