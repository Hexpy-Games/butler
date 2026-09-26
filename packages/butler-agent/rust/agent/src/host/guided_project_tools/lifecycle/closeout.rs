//! Post-mutation index, persisted views, check, and source closeout projection.

use std::path::Path;

use serde_json::{Value, json};

use crate::project_ledger::{LedgerCommand, NativeProjectLedger, ProjectLedgerReadError};

use super::{command, nonempty};

const VIEWS: [&str; 3] = ["dashboard", "handoff", "roadmap"];

pub(crate) async fn closeout(
    ledger: &NativeProjectLedger,
    root: &Path,
    mutation: Value,
) -> Result<Value, ProjectLedgerReadError> {
    let refreshed = mutation
        .pointer("/data/derived/index_refresh")
        .filter(|value| value.get("ok") == Some(&Value::Bool(true)));
    let index = if let Some(refreshed) = refreshed {
        json!({"ok":true,"data":{"index":{"path":refreshed.get("path")}}})
    } else {
        command(ledger, root, LedgerCommand::Index, json!({})).await?
    };
    let index_ok = index.get("ok") == Some(&Value::Bool(true));
    let index_path = nonempty(index.pointer("/data/index/path"));
    if !index_ok {
        let closeout = json!({
            "ok":false,"index_ok":false,"index_path":index_path,
            "index_error":error_summary(&index),
            "rendered_views":VIEWS.map(|view| json!({"view":view,"ok":false,"path":null,"written":false,"skipped":true,"reason":"index_failed"})),
            "check_ok":false,"check_skipped":true,"issue_count":0,"issues":[],"failed_stages":["index"],
        });
        return Ok(apply_closeout(mutation, closeout));
    }
    let mut rendered = Vec::with_capacity(VIEWS.len());
    for view in VIEWS {
        let result = command(
            ledger,
            root,
            LedgerCommand::Render,
            json!({"view":view,"write":true}),
        )
        .await?;
        let path = nonempty(result.pointer("/data/path"));
        let written = result.pointer("/data/written") == Some(&Value::Bool(true));
        let ok = result.get("ok") == Some(&Value::Bool(true)) && written && path.is_some();
        let mut summary = json!({"view":view,"ok":ok,"path":path,"written":written});
        if !ok {
            summary["error"] = if result.get("ok") == Some(&Value::Bool(true)) {
                let message = if written {
                    "Project Ledger render reported success without a generated view path."
                } else {
                    "Project Ledger render reported success without writing the generated view."
                };
                let reason = if path.is_some() {
                    "Rerun Project Ledger render with write enabled and verify the generated view path."
                } else {
                    "Rerun Project Ledger render with write enabled so the generated view path is available."
                };
                json!({"code":"project_ledger_render_not_written","message":message,"next":[],"native_next":[{"tool":"project_ledger_render","args":{"view":view,"write":true},"reason":reason}]})
            } else {
                error_summary(&result)
            };
        }
        rendered.push(summary);
    }
    let check = command(ledger, root, LedgerCommand::Check, json!({})).await?;
    let check_ok = check.get("ok") == Some(&Value::Bool(true));
    let issues = check
        .pointer("/data/issues")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let bounded: Vec<_> = issues.iter().take(8).map(|issue| json!({
        "code":nullable_text(issue.get("code")),"severity":nullable_text(issue.get("severity")),
        "message":nullable_text(issue.get("message")),"path":nullable_text(issue.get("path")),
        "record":nullable_text(issue.get("record")),
    })).collect();
    let count = check
        .pointer("/data/issueCount")
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .map(Value::from)
        .unwrap_or_else(|| json!(bounded.len()));
    let render_failed = rendered
        .iter()
        .any(|view| view.get("ok") != Some(&Value::Bool(true)));
    let mut failed = Vec::new();
    if render_failed {
        failed.push("render");
    }
    if !check_ok {
        failed.push("check");
    }
    let mut closeout = json!({
        "ok":failed.is_empty(),"index_ok":true,"index_path":index_path,
        "rendered_views":rendered,"check_ok":check_ok,"issue_count":count,
        "issues":bounded,"failed_stages":failed,
    });
    if render_failed {
        closeout["render_error"] = json!({"code":"project_ledger_render_failed","message":"One or more Project Ledger generated views failed to render.","details":rendered.iter().filter(|view| view.get("ok") != Some(&Value::Bool(true))).map(|view| json!({"view":view.get("view"),"error":view.get("error")})).collect::<Vec<_>>()});
    }
    if !check_ok {
        closeout["check_error"] = error_summary(&check);
    }
    Ok(apply_closeout(mutation, closeout))
}

fn nullable_text(value: Option<&Value>) -> Value {
    nonempty(value).map_or(Value::Null, |value| value.into())
}

fn error_summary(result: &Value) -> Value {
    let error = result.get("error").unwrap_or(&Value::Null);
    let source_next = error
        .get("next")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let next: Vec<_> = source_next
        .iter()
        .take(5)
        .map(|item| {
            json!({
                "command":nonempty(item.get("command")).unwrap_or(""),
                "reason":nonempty(item.get("reason")).unwrap_or("")
            })
        })
        .collect();
    let native_next = if source_next.iter().any(|item| {
        item.as_str()
            .or_else(|| item.get("command").and_then(Value::as_str))
            .is_some_and(|command| {
                let command = command.trim();
                command == "project-ledger index"
                    || command.starts_with("project-ledger index ")
                    || command == "pl index"
                    || command.starts_with("pl index ")
            })
    }) {
        vec![
            json!({"tool":"project_ledger_index","args":{},"reason":"Rebuild the compact Project Ledger index for this project."}),
        ]
    } else if matches!(
        error.get("code").and_then(Value::as_str),
        Some("record_not_found" | "ambiguous_record")
    ) {
        vec![
            json!({"tool":"project_ledger_list","args":{"kind":"all"},"reason":"List records, then retry with the exact id and kind."}),
        ]
    } else if error.get("code").and_then(Value::as_str) == Some("project_ledger_check_failed") {
        vec![
            json!({"tool":"project_ledger_check","args":{},"reason":"Review data.issues, repair source records, and rerun validation."}),
        ]
    } else {
        vec![]
    };
    json!({"code":nullable_text(error.get("code")),"message":nullable_text(error.get("message")),"next":next,"native_next":native_next})
}

fn apply_closeout(mut mutation: Value, closeout: Value) -> Value {
    if closeout.get("ok") == Some(&Value::Bool(true)) {
        mutation["project_ledger_closeout"] = closeout;
        return mutation;
    }
    let details = failure_details(&closeout);
    let hints = closeout_hints(&closeout);
    json!({"ok":false,"recoverable":true,"observation_kind":"validation_failed",
        "error":{"code":"project_ledger_closeout_failed","message":"Project Ledger lifecycle closeout failed after a successful mutation.","details":details,"native_next":hints},
        "mutation_result":mutation,"project_ledger_closeout":closeout})
}

fn failure_details(closeout: &Value) -> Vec<Value> {
    let mut details = Vec::new();
    if closeout.get("index_ok") != Some(&Value::Bool(true)) {
        details.push(json!({"code":"index_failed","kind":"project_ledger_closeout","status":"failed","message":nonempty(closeout.pointer("/index_error/message")).unwrap_or("Project Ledger index failed.")}));
    }
    for view in closeout
        .get("rendered_views")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        if view.get("ok") == Some(&Value::Bool(true))
            || view.get("skipped") == Some(&Value::Bool(true))
        {
            continue;
        }
        details.push(json!({"code":"render_failed","kind":"project_ledger_closeout","id":nonempty(view.get("view")).unwrap_or("view"),"status":"failed","message":nonempty(view.pointer("/error/message")).unwrap_or("Project Ledger generated view render failed.")}));
    }
    if closeout.get("check_ok") != Some(&Value::Bool(true))
        && closeout.get("check_skipped") != Some(&Value::Bool(true))
    {
        details.push(json!({"code":"check_failed","kind":"project_ledger_closeout","status":"failed","message":nonempty(closeout.pointer("/check_error/message")).unwrap_or("Project Ledger check failed.")}));
    }
    details
}

fn closeout_hints(closeout: &Value) -> Vec<Value> {
    let mut hints = Vec::new();
    if closeout.get("index_ok") != Some(&Value::Bool(true)) {
        hints.push(json!({"tool":"project_ledger_index","args":{},"reason":"Repair Project Ledger source records if needed, then rebuild the compact index."}));
    }
    for view in closeout
        .get("rendered_views")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        if view.get("ok") == Some(&Value::Bool(true))
            || view.get("skipped") == Some(&Value::Bool(true))
        {
            continue;
        }
        hints.push(json!({"tool":"project_ledger_render","args":{"view":nonempty(view.get("view")).unwrap_or("dashboard"),"write":true},"reason":"Rewrite the failed generated Project Ledger view after index succeeds."}));
    }
    if closeout.get("check_ok") != Some(&Value::Bool(true))
        && closeout.get("check_skipped") != Some(&Value::Bool(true))
    {
        hints.push(json!({"tool":"project_ledger_check","args":{},"reason":"Review issues, repair source records, and rerun strict validation."}));
    }
    hints
}
