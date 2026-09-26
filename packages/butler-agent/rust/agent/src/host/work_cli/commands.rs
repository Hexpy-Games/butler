use std::path::Path;

use serde_json::{Value, json};

use crate::{
    locale::LocaleCollation,
    work_records::{WorkRecordReadError, WorkRecordReader},
};

use super::{options::Options, output};

pub(super) fn execute(
    data_root: &Path,
    options: Options,
    collation: &LocaleCollation,
) -> Result<(String, Value, String), output::CommandError> {
    let reader = WorkRecordReader::new(data_root);
    let subcommand = options
        .args
        .get(1)
        .map(String::as_str)
        .unwrap_or("dashboard");
    match subcommand {
        "dashboard" => dashboard(&reader, &options, collation),
        "list" => list(&reader, &options, collation),
        "show" => show(&reader, &options, collation),
        "resume" => resume(&reader, &options, collation),
        "cancel" => unsupported_cancel(&options),
        "retry" => unsupported_retry(&options),
        other => Err(output::failure(
            "unknown_command",
            format!("unknown work command: {other}"),
            2,
        )),
    }
}

fn dashboard(
    reader: &WorkRecordReader,
    options: &Options,
    collation: &LocaleCollation,
) -> Result<(String, Value, String), output::CommandError> {
    if options.args.len() > 2 {
        return Err(output::failure(
            "invalid_arguments",
            "work dashboard accepts no positional arguments",
            2,
        ));
    }
    let mut data = reader
        .dashboard(options.debug, None, collation)
        .map_err(read_failure)?;
    sanitize_dashboard_for_cli(&mut data);
    let human = render_dashboard(&data);
    Ok(("butler work dashboard".into(), data, human))
}

fn list(
    reader: &WorkRecordReader,
    options: &Options,
    collation: &LocaleCollation,
) -> Result<(String, Value, String), output::CommandError> {
    if options.args.len() != 2 {
        return Err(output::failure(
            "invalid_arguments",
            "work list accepts only the optional --status filter",
            2,
        ));
    }
    let items = reader
        .cli_task_summaries(options.status.as_deref(), collation)
        .map_err(read_failure)?;
    let human = if items.is_empty() {
        "No work items found.".to_owned()
    } else {
        items
            .iter()
            .map(|item| {
                format!(
                    "{}: {} {}",
                    text(item, "task_id"),
                    text(item, "status"),
                    text(item, "user_summary")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok((
        "butler work list".into(),
        json!({"items":items,"status":options.status}),
        human,
    ))
}

fn show(
    reader: &WorkRecordReader,
    options: &Options,
    collation: &LocaleCollation,
) -> Result<(String, Value, String), output::CommandError> {
    if options.args.len() != 3 {
        return Err(output::failure(
            "invalid_arguments",
            "work show requires <id>",
            2,
        ));
    }
    let id = &options.args[2];
    let summary = reader
        .cli_task_summaries(None, collation)
        .map_err(read_failure)?
        .into_iter()
        .find(|item| text(item, "task_id") == id)
        .ok_or_else(|| output::failure("not_found", format!("work item not found: {id}"), 1))?;
    let human = format!(
        "{}: {}\nnext: {}",
        text(&summary, "task_id"),
        text(&summary, "user_summary"),
        text(&summary, "next_step")
    );
    Ok(("butler work show".into(), summary, human))
}

fn resume(
    reader: &WorkRecordReader,
    options: &Options,
    collation: &LocaleCollation,
) -> Result<(String, Value, String), output::CommandError> {
    if options.args.len() != 3 {
        return Err(output::failure(
            "invalid_arguments",
            "work resume requires <id|latest>",
            2,
        ));
    }
    let requested = &options.args[2];
    let task_id = if requested == "latest" {
        reader
            .cli_task_summaries(None, collation)
            .map_err(read_failure)?
            .into_iter()
            .find(|item| item.get("can_resume") == Some(&Value::Bool(true)))
            .map(|item| text(&item, "task_id").to_owned())
            .ok_or_else(|| output::failure("not_found", "no recoverable work item found", 1))?
    } else {
        requested.clone()
    };
    let summary = reader
        .cli_task_summary(&task_id)
        .map_err(read_failure)?
        .ok_or_else(|| output::failure("invalid_state", format!("task not found: {task_id}"), 1))?;
    if text(&summary, "status") != "RECOVERABLE" {
        return Err(output::failure(
            "invalid_state",
            format!(
                "task is {}; only RECOVERABLE tasks can be resumed",
                text(&summary, "status")
            ),
            1,
        ));
    }
    let reason = "No native execution owner is available to resume this legacy task.";
    let message = "resume intent validated; no worker was started";
    let result = json!({
        "ok":true,
        "action":"resume",
        "message":message,
        "resumed":false,
        "intent":{
            "action":"resume",
            "label":"Resume",
            "task_id":task_id,
            "enabled":false,
            "reason":reason
        }
    });
    Ok((
        "butler work resume".into(),
        result,
        format!("{message}: {task_id}"),
    ))
}

fn unsupported_cancel(options: &Options) -> Result<(String, Value, String), output::CommandError> {
    if !options.yes {
        return Err(output::failure(
            "invalid_arguments",
            "work cancel requires --yes or --non-interactive",
            2,
        ));
    }
    if options.args.len() != 3 {
        return Err(output::failure(
            "invalid_arguments",
            "work cancel requires <id>",
            2,
        ));
    }
    Err(output::failure(
        "unsupported_operation",
        "legacy work cancellation is unavailable because no native execution owner is configured.",
        2,
    ))
}

fn unsupported_retry(options: &Options) -> Result<(String, Value, String), output::CommandError> {
    if options.args.len() != 3 {
        return Err(output::failure(
            "invalid_arguments",
            "work retry requires <id>",
            2,
        ));
    }
    Err(output::failure(
        "unsupported_operation",
        "legacy work delivery retry is unavailable because no native delivery owner is configured.",
        2,
    ))
}

fn read_failure(_: WorkRecordReadError) -> output::CommandError {
    output::failure(
        "work_records_unavailable",
        "Work records are unavailable.",
        1,
    )
}

fn sanitize_dashboard_for_cli(data: &mut Value) {
    for key in ["active", "recoverable", "failed", "reportReady"] {
        if let Some(items) = data.get_mut(key).and_then(Value::as_array_mut) {
            for item in items {
                item["summary"] = format!(
                    "{} work state is {}.",
                    text(item, "task_type"),
                    text(item, "status")
                )
                .into();
            }
        }
    }
    if let Some(items) = data.get_mut("delivery").and_then(Value::as_array_mut) {
        for item in items {
            item["summary"] = format!("Delivery notification is {}.", text(item, "status")).into();
        }
    }
}

fn render_dashboard(data: &Value) -> String {
    let counts = &data["counts"];
    let mut lines = vec![
        "## Work Dashboard".to_owned(),
        format!(
            "active={} recoverable={} failed={} report_ready={}",
            count(counts, "active"),
            count(counts, "recoverable"),
            count(counts, "failed"),
            count(counts, "reportReady")
        ),
        format!(
            "delivery_pending={} delivery_failed={}",
            count(counts, "pendingDelivery"),
            count(counts, "failedDelivery")
        ),
    ];
    for (label, key) in [
        ("Active", "active"),
        ("Recoverable", "recoverable"),
        ("Failed", "failed"),
        ("Report Ready", "reportReady"),
    ] {
        let Some(items) = data.get(key).and_then(Value::as_array) else {
            continue;
        };
        if items.is_empty() {
            continue;
        }
        lines.push(String::new());
        lines.push(format!("— {label} —"));
        for item in items {
            lines.push(format!(
                "{}: {}",
                text(item, "label"),
                text(item, "summary")
            ));
            if data.get("debug") == Some(&Value::Bool(true))
                && let Some(id) = item.get("raw_id").and_then(Value::as_str)
            {
                lines.push(format!("  id: {id}"));
            }
            lines.push(format!("  mode: {}", text(item, "work_mode")));
            if let Some(reason) = item.get("guard_reason").and_then(Value::as_str) {
                lines.push(format!("  guard: {reason}"));
            }
            lines.push(format!("  next: {}", text(item, "next_step")));
        }
    }
    if let Some(items) = data.get("delivery").and_then(Value::as_array)
        && !items.is_empty()
    {
        lines.push(String::new());
        lines.push("— Delivery —".into());
        for item in items {
            lines.push(format!(
                "{}: {} — {}",
                text(item, "label"),
                text(item, "status"),
                text(item, "summary")
            ));
            if data.get("debug") == Some(&Value::Bool(true))
                && let Some(id) = item.get("raw_id").and_then(Value::as_str)
            {
                lines.push(format!("  notification: {id}"));
            }
        }
    }
    lines.join("\n")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn count(value: &Value, key: &str) -> usize {
    value.get(key).and_then(Value::as_u64).unwrap_or(0) as usize
}
