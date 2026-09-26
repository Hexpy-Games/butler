//! One-shot native automation commands over the existing DATA file store.

mod helpers;
mod render;
#[cfg(test)]
#[path = "automation_cli_tests.rs"]
mod tests;

use std::{ffi::OsString, path::PathBuf, process::ExitCode};

use serde_json::json;

use super::{ResolvedInstallation, settings_cli};
use crate::{models::ModelConfigurationClock, operations};
use helpers::{command_id, command_name, command_name_os, required_value, valid_id};
use render::{redact_json_strings, report_error, report_success, safe_preview};

const STORE_MUTATION_PATHS: &[&str] = &["automations", "automations/.automation-store.lock"];

#[derive(Default)]
struct Options {
    data: Option<PathBuf>,
    json: bool,
    quiet: bool,
    yes: bool,
    non_interactive: bool,
    include_deleted: bool,
    status: Option<String>,
    positionals: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Command {
    List,
    Show(String),
    Run(String),
    Delete(String),
    MissingId(&'static str),
    Unknown,
}

impl Command {
    fn parse(values: &[String]) -> Option<Self> {
        if values.first().map(String::as_str) != Some("automation") {
            return None;
        }
        Some(match values.get(1).map(String::as_str) {
            Some("list") if values.len() == 2 => Self::List,
            Some("show") if values.len() == 2 => Self::MissingId("show"),
            Some("show") if values.len() == 3 => Self::Show(values[2].clone()),
            Some("run") if values.len() == 2 => Self::MissingId("run"),
            Some("run") if values.len() == 3 => Self::Run(values[2].clone()),
            Some("delete") if values.len() == 2 => Self::MissingId("delete"),
            Some("delete") if values.len() == 3 => Self::Delete(values[2].clone()),
            _ => Self::Unknown,
        })
    }

    fn name(&self) -> &'static str {
        match self {
            Self::List => "butler automation list",
            Self::Show(_) => "butler automation show",
            Self::Run(_) => "butler automation run",
            Self::Delete(_) => "butler automation delete",
            Self::MissingId("show") => "butler automation show",
            Self::MissingId("run") => "butler automation run",
            Self::MissingId("delete") => "butler automation delete",
            Self::MissingId(_) => "butler automation",
            Self::Unknown => "butler automation",
        }
    }
}

struct CliError {
    code: &'static str,
    message: String,
    exit: u8,
}

impl CliError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_arguments",
            message: message.into(),
            exit: 2,
        }
    }

    fn failed(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            exit: 1,
        }
    }
}

pub fn recognizes(args: &[OsString]) -> bool {
    positionals_without_options(args)
        .first()
        .is_some_and(|value| value == "automation")
}

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let options = match parse(&args) {
        Ok(options) => options,
        Err((command, error)) => return report_error(command, json_requested, error),
    };
    let Some(command) = Command::parse(&options.positionals) else {
        return report_error(
            command_name(&options.positionals),
            options.json,
            CliError::invalid("automation requires list, show <id>, run <id>, or delete <id>"),
        );
    };
    if command == Command::Unknown {
        return report_error(
            command.name(),
            options.json,
            CliError {
                code: "unknown_command",
                message: format!(
                    "unknown automation command: {}",
                    options.positionals.get(1).map_or("", String::as_str)
                ),
                exit: 2,
            },
        );
    }
    if is_delete_command(&command) && !(options.yes || options.non_interactive) {
        return report_error(
            command.name(),
            options.json,
            CliError::invalid("automation delete requires --yes or --non-interactive"),
        );
    }
    if let Command::MissingId(action) = &command {
        return report_error(
            command.name(),
            options.json,
            CliError::invalid(format!("automation {action} requires <id>")),
        );
    }
    if options.status.is_some() && command != Command::List {
        return report_error(
            command.name(),
            options.json,
            CliError::invalid("--status is only supported by automation list"),
        );
    }
    if options.include_deleted && command != Command::List {
        return report_error(
            command.name(),
            options.json,
            CliError::invalid("--include-deleted is only supported by automation list"),
        );
    }
    let data_root =
        match settings_cli::resolve_data_root_override(options.data.clone(), &installation) {
            Ok(root) => root,
            Err(_) => {
                return report_error(
                    command.name(),
                    options.json,
                    CliError::failed("butler_data_unavailable", "Butler DATA is unavailable."),
                );
            }
        };
    if let Some(id) = command_id(&command) {
        if !valid_id(id) {
            return report_error(
                command.name(),
                options.json,
                CliError::invalid("automation id must contain 1-100 safe characters"),
            );
        }
        if matches!(&command, Command::Run(_) | Command::Delete(_)) {
            let record_path = format!("automations/{}.json", id.trim());
            let mut paths = STORE_MUTATION_PATHS.to_vec();
            paths.push(&record_path);
            if settings_cli::validate_data_mutation_paths(&data_root, &installation, &paths)
                .is_err()
            {
                return report_error(
                    command.name(),
                    options.json,
                    CliError::failed(
                        "unsafe_path",
                        "automation writes require non-symlink paths inside DATA",
                    ),
                );
            }
        }
    }

    let store = operations::NativeAutomationCliStore::new(data_root);
    let command_name = command.name();
    let result = match command {
        Command::List => store
            .list(options.include_deleted, options.status.as_deref())
            .map_err(|error| CliError::failed("automation_store_unavailable", error.message))
            .map(|items| {
                let items: Vec<_> = items.into_iter().map(safe_preview).collect();
                let human = if items.is_empty() {
                    "No automations found.".to_owned()
                } else {
                    items
                        .iter()
                        .map(|item| {
                            format!(
                                "{}: {} next={}",
                                item["id"].as_str().unwrap_or(""),
                                item["status"].as_str().unwrap_or(""),
                                item["next_run_at"].as_str().unwrap_or("none")
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                (json!({"automations":items}), human)
            }),
        Command::Show(id) => store
            .show(&id)
            .map_err(|error| CliError::failed("automation_store_unavailable", error.message))
            .and_then(|item| {
                let item = item.ok_or_else(|| {
                    CliError::failed("not_found", format!("automation not found: {id}"))
                })?;
                let item = safe_preview(item);
                let human = format!(
                    "{}: {} next={}",
                    item["id"].as_str().unwrap_or(""),
                    item["status"].as_str().unwrap_or(""),
                    item["next_run_at"].as_str().unwrap_or("none")
                );
                Ok((json!({"automation":item}), human))
            }),
        Command::Run(id) => store
            .run_now(&id, now_millis())
            .map_err(|error| CliError::failed("invalid_state", error.message))
            .map(|value| {
                let automation = safe_preview(value["automation"].clone());
                let envelope = redact_json_strings(value["envelope"].clone());
                let human = format!(
                    "Automation run claimed: {}",
                    automation["id"].as_str().unwrap_or("")
                );
                (
                    json!({"automation":automation,"envelope":envelope,"dispatched":false}),
                    human,
                )
            }),
        Command::Delete(id) => store
            .delete(&id, now_millis())
            .map_err(|error| {
                let missing = error.message.contains("not found");
                CliError::failed(
                    if missing {
                        "not_found"
                    } else {
                        "automation_store_unavailable"
                    },
                    error.message,
                )
            })
            .map(|value| {
                let automation = safe_preview(value);
                let human = format!(
                    "Automation deleted: {}",
                    automation["id"].as_str().unwrap_or("")
                );
                (json!({"automation":automation}), human)
            }),
        Command::MissingId(_) | Command::Unknown => unreachable!(),
    };
    match result {
        Ok((data, human)) => report_success(&options, command_name, data, &human),
        Err(error) => report_error(command_name, options.json, error),
    }
}

fn is_delete_command(command: &Command) -> bool {
    matches!(command, Command::Delete(_) | Command::MissingId("delete"))
}

fn parse(args: &[OsString]) -> Result<Options, (&'static str, CliError)> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" => {
                let path = required_value(args, index, "--data")?;
                options.data = Some(PathBuf::from(path));
                index += 2;
            }
            "--status" => {
                let status = required_value(args, index, "--status")?;
                options.status = Some(status.to_string_lossy().into_owned());
                index += 2;
            }
            "--home" => {
                return Err((
                    command_name_os(args),
                    CliError::invalid("--home is unsupported; use --data for writable state"),
                ));
            }
            "--json" => {
                options.json = true;
                index += 1;
            }
            "--quiet" | "--silent" => {
                options.quiet = true;
                index += 1;
            }
            "--yes" => {
                options.yes = true;
                index += 1;
            }
            "--non-interactive" => {
                options.non_interactive = true;
                index += 1;
            }
            "--include-deleted" => {
                options.include_deleted = true;
                index += 1;
            }
            "--verbose" => index += 1,
            value if value.starts_with('-') => {
                return Err((
                    command_name_os(args),
                    CliError::invalid(format!("unsupported option: {value}")),
                ));
            }
            _ => {
                let Some(value) = args[index].to_str() else {
                    return Err((
                        command_name_os(args),
                        CliError::invalid("automation arguments must be valid UTF-8"),
                    ));
                };
                options.positionals.push(value.to_owned());
                index += 1;
            }
        }
    }
    if options.positionals.first().map(String::as_str) != Some("automation") {
        return Err((
            command_name(&options.positionals),
            CliError::invalid("automation command is required"),
        ));
    }
    Ok(options)
}

fn positionals_without_options(args: &[OsString]) -> Vec<String> {
    let mut values = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].to_string_lossy().as_ref() {
            "--data" | "--status" | "--home" => index += 2,
            "--json" | "--quiet" | "--silent" | "--yes" | "--non-interactive"
            | "--include-deleted" | "--verbose" => index += 1,
            value if value.starts_with('-') => index += 1,
            _ => {
                values.push(args[index].to_string_lossy().into_owned());
                index += 1;
            }
        }
    }
    values
}

fn now_millis() -> i64 {
    ModelConfigurationClock::now_epoch_millis(&super::SystemIdentity)
}
