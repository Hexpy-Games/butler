use serde_json::{Value, json};

use crate::cognition::BoxStoreService;

use super::CliError;

pub(super) fn command_name(prefix: &str, args: &[String]) -> String {
    let rest = args.get(2..).unwrap_or_default();
    let subcommand = rest.first().map(String::as_str).unwrap_or("list");
    format!("butler {prefix} box {subcommand}")
}

pub(super) async fn run(
    service: BoxStoreService,
    args: &[String],
    yes: bool,
    non_interactive: bool,
) -> Result<(Value, String), CliError> {
    let rest = args.get(2..).unwrap_or_default();
    let subcommand = rest.first().map(String::as_str).unwrap_or("list");
    match subcommand {
        "list" => {
            let limit = numeric_option(rest, "--limit", 100, 500);
            let items = service.operator_list(limit).await.map_err(service_error)?;
            let human = if items.is_empty() {
                "No Box items.".to_owned()
            } else {
                items
                    .iter()
                    .map(|item| {
                        format!(
                            "{}: {} {} {}",
                            string(item, "box_item_id"),
                            string(item, "status"),
                            string(item, "kind"),
                            string(item, "title"),
                        )
                        .trim_end()
                        .to_owned()
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            Ok((json!({ "items": items }), human))
        }
        "show" => {
            let id = required_id(rest, "show")?;
            let value = service
                .operator_show(id)
                .await
                .map_err(service_error)?
                .ok_or_else(|| not_found(id))?;
            Ok((
                value.clone(),
                format!(
                    "{}: {} {}",
                    string(&value["item"], "box_item_id"),
                    string(&value["item"], "status"),
                    string(&value["item"], "title"),
                ),
            ))
        }
        "inspect" => {
            let id = required_id(rest, "inspect")?;
            let include_raw = rest.iter().any(|value| value == "--include-raw");
            let value = service
                .operator_inspect(id, include_raw)
                .await
                .map_err(service_error)?
                .ok_or_else(|| not_found(id))?;
            Ok((
                value.clone(),
                format!(
                    "{}: {} {}",
                    string(&value["item"], "box_item_id"),
                    string(&value["item"], "status"),
                    string(&value["item"], "title"),
                ),
            ))
        }
        "forget" => {
            let id = required_id(rest, "forget")?;
            if !yes && !non_interactive {
                return Err(CliError::invalid("box forget requires --yes"));
            }
            let mode = option_value(rest, "--mode").unwrap_or_else(|| "hide".to_owned());
            if !matches!(mode.as_str(), "hide" | "derived" | "raw") {
                return Err(CliError::invalid(
                    "box forget --mode must be hide, derived, or raw",
                ));
            }
            let value = service
                .operator_forget(id, &mode)
                .await
                .map_err(service_error)?
                .ok_or_else(|| not_found(id))?;
            Ok((value, format!("Box item forgotten: {id}")))
        }
        "rebuild-index" => {
            let report = service.rebuild_index().await.map_err(service_error)?;
            let data = serde_json::to_value(&report).map_err(|_| {
                CliError::failed("invalid_output", "Could not serialize Box index report")
            })?;
            Ok((
                data,
                format!(
                    "Box index rebuilt: indexed={} skipped={}",
                    report.indexed_count, report.skipped_count
                ),
            ))
        }
        _ => Err(CliError::failed(
            "unknown_command",
            format!("unknown box command: {subcommand}"),
        )),
    }
}

fn required_id<'a>(args: &'a [String], command: &str) -> Result<&'a str, CliError> {
    args.get(1)
        .filter(|value| !value.starts_with('-'))
        .map(String::as_str)
        .ok_or_else(|| CliError::invalid(format!("box {command} requires <box_item_id>")))
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

fn not_found(id: &str) -> CliError {
    CliError::failed("not_found", format!("Box item not found: {id}"))
}

fn service_error(error: crate::cognition::CognitionError) -> CliError {
    CliError::failed(error.code, error.message)
}
