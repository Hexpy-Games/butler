use std::{ffi::OsString, path::PathBuf, sync::Arc};

use serde_json::{Value, json};

use crate::{
    cognition::{CognitionPathEnvironment, CompletionPublisher, FeedbackBufferService},
    coordination::CognitionWriteCoordinator,
};

use super::{CliError, parser};

pub(super) fn recognizes(args: &[OsString]) -> bool {
    let values = parser::positionals_without_options(args);
    let rest = values.get(2..).unwrap_or_default();
    let subcommand = rest.first().map(String::as_str).unwrap_or("list");
    match subcommand {
        "list" | "add" | "show" => true,
        "resolve" => true,
        "clear" => rest.iter().any(|value| value == "--applied"),
        _ => false,
    }
}

pub(super) fn command_name(prefix: &str, args: &[String]) -> String {
    let rest = args.get(2..).unwrap_or_default();
    let subcommand = rest.first().map(String::as_str).unwrap_or("list");
    if subcommand == "clear" && rest.iter().any(|value| value == "--applied") {
        format!("butler {prefix} feedback clear --applied")
    } else {
        format!("butler {prefix} feedback {subcommand}")
    }
}

pub(super) async fn run(
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    args: &[String],
    yes: bool,
    non_interactive: bool,
    publisher: CompletionPublisher,
) -> Result<(Value, String), CliError> {
    let rest = args.get(2..).unwrap_or_default();
    let subcommand = rest.first().map(String::as_str).unwrap_or("list");
    let service = FeedbackBufferService::new(data_root, paths, coordinator);
    match subcommand {
        "list" => {
            let entries = service
                .operator_entries()
                .await
                .map_err(|error| CliError::failed(error.code, error.message))?;
            let summaries = entries.iter().map(list_summary).collect::<Vec<_>>();
            let human = if entries.is_empty() {
                "No feedback entries.".to_owned()
            } else {
                entries
                    .iter()
                    .map(|entry| {
                        format!(
                            "{}: {} {}",
                            string(entry, "feedback_id"),
                            string(entry, "status"),
                            string(entry, "target_ref"),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            Ok((json!({ "entries": summaries }), human))
        }
        "add" => {
            let Some(text) = option_value(rest, "--text").filter(|text| !text.is_empty()) else {
                return Err(CliError::invalid("feedback add requires --text"));
            };
            let entry = service
                .operator_add(
                    text,
                    option_value(rest, "--target").unwrap_or_else(|| "unknown".into()),
                    option_value(rest, "--category").unwrap_or_else(|| "unrouted".into()),
                    option_value(rest, "--scope").unwrap_or_else(|| "global".into()),
                    option_value(rest, "--promotion-target").unwrap_or_else(|| "discard".into()),
                )
                .await
                .map_err(|error| CliError::failed(error.code, error.message))?;
            let id = string(&entry, "feedback_id");
            Ok((
                json!({ "entry": entry }),
                format!("Feedback recorded: {id}"),
            ))
        }
        "show" => {
            let id = rest
                .get(1)
                .filter(|id| !id.starts_with('-'))
                .ok_or_else(|| CliError::invalid("feedback show requires <feedback_id>"))?;
            let Some(entry) = service
                .operator_read(id)
                .await
                .map_err(|error| CliError::failed(error.code, error.message))?
            else {
                return Err(CliError::failed(
                    "not_found",
                    format!("feedback not found: {id}"),
                ));
            };
            let human = format!(
                "{}: {} {}\n{}",
                string(&entry, "feedback_id"),
                string(&entry, "status"),
                string(&entry, "target_ref"),
                string(&entry, "text"),
            );
            Ok((json!({ "entry": entry }), human))
        }
        "resolve" => {
            let id = rest
                .get(1)
                .filter(|id| !id.starts_with('-'))
                .ok_or_else(|| CliError::invalid("feedback resolve requires <feedback_id>"))?;
            let status = option_value(rest, "--status").unwrap_or_else(|| "applied".into());
            if !matches!(
                status.as_str(),
                "applied" | "discarded" | "superseded" | "needs_clarification"
            ) {
                return Err(CliError::invalid(
                    "feedback resolve --status must be applied, discarded, superseded, or needs_clarification",
                ));
            }
            let quality_operation = if let Some(intent) = option_value(rest, "--intent") {
                if intent != "exclude"
                    || option_value(rest, "--actor").as_deref() != Some("operator")
                {
                    return Err(CliError::invalid(
                        "feedback quality intent requires --intent exclude --actor operator",
                    ));
                }
                let operation_id = option_value(rest, "--operation-id")
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        CliError::invalid(
                            "feedback exclude requires --operation-id, --source-ref, and --scope",
                        )
                    })?;
                let source_ref = option_value(rest, "--source-ref")
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        CliError::invalid(
                            "feedback exclude requires --operation-id, --source-ref, and --scope",
                        )
                    })?;
                let scope = option_value(rest, "--scope")
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        CliError::invalid(
                            "feedback exclude requires --operation-id, --source-ref, and --scope",
                        )
                    })?;
                if scope != "all_user_sessions" || !source_ref.starts_with("memory-source:v2:") {
                    return Err(CliError::invalid(
                        "feedback exclude requires an authorized all_user_sessions memory-source:v2 locator",
                    ));
                }
                Some(
                    service
                        .operator_quality_exclusion(
                            id,
                            &operation_id,
                            &source_ref,
                            &scope,
                            publisher,
                        )
                        .await
                        .map_err(|error| {
                            if error.code == "memory_feedback_entry_not_found" {
                                CliError::failed("not_found", format!("feedback not found: {id}"))
                            } else {
                                CliError::failed(error.code, error.message)
                            }
                        })?,
                )
            } else {
                None
            };
            let entry = service
                .operator_resolve(id, &status)
                .await
                .map_err(|error| {
                    if error.code == "memory_feedback_entry_not_found" {
                        CliError::failed("not_found", format!("feedback not found: {id}"))
                    } else {
                        CliError::failed(error.code, error.message)
                    }
                })?;
            let data = if let Some(quality_operation) = quality_operation {
                json!({ "entry": entry, "quality_operation": quality_operation })
            } else {
                json!({ "entry": entry })
            };
            Ok((
                data,
                format!(
                    "Feedback {}: {}",
                    string(&entry, "status"),
                    string(&entry, "feedback_id"),
                ),
            ))
        }
        "clear" if rest.iter().any(|value| value == "--applied") => {
            if !yes && !non_interactive {
                return Err(CliError::invalid("feedback clear requires --yes"));
            }
            let (removed, remaining) = service
                .operator_clear_resolved()
                .await
                .map_err(|error| CliError::failed(error.code, error.message))?;
            Ok((
                json!({ "removed": removed, "remaining": remaining }),
                format!("Feedback cleared: removed={removed} remaining={remaining}"),
            ))
        }
        _ => Err(CliError::invalid(format!(
            "unknown feedback command: {subcommand}"
        ))),
    }
}

fn list_summary(entry: &Value) -> Value {
    let text_chars = entry
        .get("text")
        .and_then(Value::as_str)
        .map_or(0, |text| text.encode_utf16().count());
    json!({
        "feedback_id": entry["feedback_id"],
        "status": entry["status"],
        "priority": entry["priority"],
        "scope": entry["scope"],
        "category": entry["category"],
        "target_ref": entry["target_ref"],
        "promotion_target": entry["promotion_target"],
        "created_at": entry["created_at"],
        "updated_at": entry["updated_at"],
        "review_after": entry["review_after"],
        "expires_at": entry["expires_at"],
        "privacy_class": entry["privacy_class"],
        "text_chars": text_chars,
    })
}

fn option_value(args: &[String], option: &str) -> Option<String> {
    let equals_prefix = format!("{option}=");
    args.iter().enumerate().find_map(|(index, value)| {
        if value == option {
            args.get(index + 1).cloned()
        } else {
            value.strip_prefix(&equals_prefix).map(str::to_owned)
        }
    })
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
