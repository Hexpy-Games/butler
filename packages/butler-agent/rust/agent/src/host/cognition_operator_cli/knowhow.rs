use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::cognition::{CognitionPathEnvironment, FeedbackBufferService, KnowHowService};

use super::CliError;

pub(super) fn command_name(prefix: &str, args: &[String]) -> String {
    let rest = args.get(2..).unwrap_or_default();
    let subcommand = rest.first().map(String::as_str).unwrap_or("list");
    format!("butler {prefix} know-how {subcommand}")
}

pub(super) async fn run(
    service: KnowHowService,
    data_root: std::path::PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: std::sync::Arc<crate::coordination::CognitionWriteCoordinator>,
    args: &[String],
    yes: bool,
    non_interactive: bool,
) -> Result<(Value, String), CliError> {
    let rest = args.get(2..).unwrap_or_default();
    let subcommand = rest.first().map(String::as_str).unwrap_or("list");
    match subcommand {
        "list" => {
            let entries = service.operator_entries().await.map_err(service_error)?;
            let human = if entries.is_empty() {
                "No know-how entries.".to_owned()
            } else {
                entries
                    .iter()
                    .map(|entry| {
                        format!(
                            "{}: {} {}",
                            string(entry, "knowhow_id"),
                            string(entry, "status"),
                            string(entry, "name"),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            Ok((json!({ "entries": entries }), human))
        }
        "show" => {
            let id = required_id(rest, "show")?;
            let entry = service
                .operator_read(id)
                .await
                .map_err(service_error)?
                .ok_or_else(|| {
                    CliError::failed("not_found", format!("know-how not found: {id}"))
                })?;
            Ok((
                json!({ "entry": entry }),
                format!(
                    "{}: {}",
                    string(&entry, "knowhow_id"),
                    string(&entry, "summary"),
                ),
            ))
        }
        "disable" => {
            let id = required_id(rest, "disable")?;
            if !yes && !non_interactive {
                return Err(CliError::invalid("know-how disable requires --yes"));
            }
            let entry = service
                .operator_disable(id)
                .await
                .map_err(service_error)?
                .ok_or_else(|| {
                    CliError::failed("not_found", format!("know-how not found: {id}"))
                })?;
            Ok((
                json!({ "entry": entry }),
                format!("Know-how disabled: {id}"),
            ))
        }
        "retrieve" => {
            let query = rest
                .iter()
                .skip(1)
                .filter(|argument| !argument.starts_with("--"))
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(" ")
                .trim()
                .to_owned();
            if query.is_empty() {
                return Err(CliError::invalid("know-how retrieve requires <query>"));
            }
            let limit = numeric_option(rest, "--limit", 5, 500);
            let feedback = FeedbackBufferService::new(data_root, paths, coordinator);
            let targets = feedback
                .active_targets(now_millis())
                .await
                .map_err(service_error)?;
            let result = service
                .operator_retrieve(&query, limit, &targets)
                .await
                .map_err(service_error)?;
            let selected = &result["selected"];
            let human = if selected.is_null() {
                "No applicable know-how.".to_owned()
            } else {
                format!(
                    "{}: {}",
                    string(selected, "knowhow_id"),
                    string(selected, "name"),
                )
            };
            Ok((result, human))
        }
        "source-quality" => {
            let summaries = service
                .operator_source_quality()
                .await
                .map_err(service_error)?;
            let human = if summaries.is_empty() {
                "No source-quality events.".to_owned()
            } else {
                summaries
                    .iter()
                    .map(|summary| {
                        format!(
                            "{}/{}: score={} events={}",
                            string(summary, "tool_name"),
                            string(summary, "source_id"),
                            display(&summary["score"]),
                            display(&summary["event_count"]),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            Ok((json!({ "summaries": summaries }), human))
        }
        "rebuild-index" => {
            let report = service
                .operator_rebuild_index()
                .await
                .map_err(service_error)?;
            Ok((
                report.clone(),
                format!(
                    "Know-how index rebuilt: indexed={} sourceQuality={}",
                    display(&report["indexed_count"]),
                    display(&report["source_quality_count"]),
                ),
            ))
        }
        _ => Err(CliError::failed(
            "unknown_command",
            format!("unknown know-how command: {subcommand}"),
        )),
    }
}

fn required_id<'a>(args: &'a [String], command: &str) -> Result<&'a str, CliError> {
    args.get(1)
        .filter(|id| !id.starts_with('-'))
        .map(String::as_str)
        .ok_or_else(|| CliError::invalid(format!("know-how {command} requires <knowhow_id>")))
}

fn option_value(args: &[String], option: &str) -> Option<String> {
    let prefix = format!("{option}=");
    args.iter().enumerate().find_map(|(index, value)| {
        if value == option {
            args.get(index + 1).cloned()
        } else {
            value.strip_prefix(&prefix).map(str::to_owned)
        }
    })
}

fn numeric_option(args: &[String], option: &str, fallback: usize, max: usize) -> usize {
    let Some(value) = option_value(args, option).filter(|value| !value.is_empty()) else {
        return fallback;
    };
    let Ok(value) = value.parse::<f64>() else {
        return fallback;
    };
    if !value.is_finite() || value < 0.0 {
        return fallback;
    }
    crate::json::saturating_usize(value.trunc()).min(max)
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn display(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => value.to_string(),
    }
}

fn now_millis() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128),
    )
    .unwrap_or(i64::MAX)
}

fn service_error(error: crate::cognition::CognitionError) -> CliError {
    CliError::failed(error.code, error.message)
}
