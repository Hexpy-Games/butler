//! Translate source tool arguments to the canonical command's parsed CLI options.

use serde_json::{Map, Value};

use crate::{btcc::BtccError, project_ledger::LedgerCommand, public_text::trim_js_whitespace};

pub(super) fn acceptance(args: &Map<String, Value>) -> Map<String, Value> {
    let mut args = args.clone();
    let value = match args.get("acceptance") {
        Some(Value::String(value)) => trimmed(value).map(str::to_owned),
        Some(Value::Array(items)) => {
            let items: Vec<_> = items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(trimmed)
                .collect();
            (!items.is_empty()).then(|| items.join("\n"))
        }
        _ => None,
    };
    args.remove("acceptance");
    if let Some(value) = value {
        args.insert("acceptance".into(), value.into());
    }
    args
}

pub(super) fn command(
    name: &str,
    args: &Map<String, Value>,
) -> Result<(LedgerCommand, Value), BtccError> {
    let mut options = Map::new();
    let command = match name {
        "project_ledger_status" | "inspect_project_status" => LedgerCommand::Status,
        "project_ledger_index" => LedgerCommand::Index,
        "project_ledger_list" => {
            options.insert("kind".into(), text(args, "kind").unwrap_or("all").into());
            for key in ["status", "query"] {
                string(&mut options, args, key, key);
            }
            let limit = args
                .get("limit")
                .and_then(Value::as_f64)
                .filter(|value| *value > 0.0)
                .map(f64::floor)
                .unwrap_or(50.0);
            let limit = crate::json::stringify(&Value::from(limit))
                .map_err(|_| error("project_ledger_tool_limit_invalid"))?;
            options.insert("limit".into(), limit.into());
            LedgerCommand::Query
        }
        "query_project_work" => {
            options.insert(
                "kind".into(),
                text(args, "kind")
                    .ok_or_else(|| error("query_project_work requires kind"))?
                    .into(),
            );
            LedgerCommand::Query
        }
        "project_ledger_show" => {
            options.insert("id".into(), text(args, "id").unwrap_or("").into());
            string(&mut options, args, "kind", "kind");
            flag(&mut options, args, "include_body", "body");
            LedgerCommand::Show
        }
        "project_ledger_check" => {
            flag(&mut options, args, "verbose", "verbose");
            LedgerCommand::Check
        }
        "project_ledger_render" | "render_project_dashboard" => {
            let view = text(args, "view").unwrap_or("");
            if name == "render_project_dashboard" && view.is_empty() {
                return Err(error("render_project_dashboard requires view"));
            }
            options.insert("view".into(), view.into());
            flag(&mut options, args, "write", "write");
            LedgerCommand::Render
        }
        "project_ledger_create" => {
            let kind = text(args, "kind").unwrap_or("");
            options.insert("title".into(), text(args, "title").unwrap_or("").into());
            match kind {
                "work" => LedgerCommand::WorkCreate,
                "task" => {
                    options.insert("work".into(), text(args, "work_id").unwrap_or("").into());
                    LedgerCommand::TaskCreate
                }
                "attempt" => {
                    options.insert("task".into(), text(args, "task_id").unwrap_or("").into());
                    LedgerCommand::AttemptStart
                }
                _ => {
                    options.insert("kind".into(), kind.into());
                    LedgerCommand::RecordCreate
                }
            }
        }
        "project_ledger_update" => {
            string(&mut options, args, "kind", "kind");
            LedgerCommand::RecordUpdate
        }
        "project_ledger_work_update" => LedgerCommand::WorkUpdate,
        "project_ledger_work_complete" | "complete_project_work" => LedgerCommand::WorkComplete,
        "project_ledger_task_update" => LedgerCommand::TaskUpdate,
        "project_ledger_task_complete" => LedgerCommand::TaskComplete,
        "project_ledger_attempt_start" => LedgerCommand::AttemptStart,
        "project_ledger_attempt_succeed" => LedgerCommand::AttemptSucceed,
        "project_ledger_attempt_fail" => LedgerCommand::AttemptFail,
        _ => return Err(error("guided_project_tool_unknown")),
    };
    if matches!(
        command,
        LedgerCommand::RecordCreate
            | LedgerCommand::RecordUpdate
            | LedgerCommand::WorkCreate
            | LedgerCommand::TaskCreate
            | LedgerCommand::WorkUpdate
            | LedgerCommand::WorkComplete
            | LedgerCommand::TaskUpdate
            | LedgerCommand::TaskComplete
            | LedgerCommand::AttemptStart
            | LedgerCommand::AttemptSucceed
            | LedgerCommand::AttemptFail
    ) {
        if name == "project_ledger_attempt_start" {
            options.insert("task".into(), text(args, "task_id").unwrap_or("").into());
            string(&mut options, args, "id", "id");
        } else {
            options.insert("id".into(), text(args, "id").unwrap_or("").into());
        }
        for (input, output) in [
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
            ("body", "body"),
        ] {
            string(&mut options, args, input, output);
        }
        flag(
            &mut options,
            args,
            "requires_commit_evidence",
            "requires-commit-evidence",
        );
        if let Some(value) = args
            .get("priority")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
        {
            options.insert(
                "priority".into(),
                crate::json::stringify(&Value::from(value))
                    .map_err(|_| error("project_ledger_tool_priority_invalid"))?
                    .into(),
            );
        }
    }
    Ok((command, Value::Object(options)))
}

fn text<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).and_then(trimmed)
}
fn trimmed(value: &str) -> Option<&str> {
    let value = trim_js_whitespace(value);
    (!value.is_empty()).then_some(value)
}
fn string(out: &mut Map<String, Value>, args: &Map<String, Value>, input: &str, output: &str) {
    if let Some(value) = text(args, input) {
        out.insert(output.into(), value.into());
    }
}
fn flag(out: &mut Map<String, Value>, args: &Map<String, Value>, input: &str, output: &str) {
    if args.get(input) == Some(&Value::Bool(true)) {
        out.insert(output.into(), Value::Bool(true));
    }
}
fn error(message: &str) -> BtccError {
    BtccError::relayed("project_ledger_tool_arguments", message)
}
