//! Native one-shot context status, compaction, and retention commands.

use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::ExitCode,
    sync::Arc,
};

use serde_json::{Value, json};

use super::{ResolvedInstallation, settings_cli};
use crate::{
    context::{ContextBudgetEnvironment, ContextBudgetOwner},
    models,
};

mod compaction;
mod maintenance;
mod status;

#[derive(Default)]
struct Options {
    data: Option<PathBuf>,
    session: Option<String>,
    json: bool,
    quiet: bool,
    yes: bool,
    non_interactive: bool,
    positionals: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command {
    Status,
    Compact,
    Prune,
    MaintenanceContext,
}

impl Command {
    fn name(self) -> &'static str {
        match self {
            Self::Status => "butler context status",
            Self::Compact => "butler context compact",
            Self::Prune => "butler context prune",
            Self::MaintenanceContext => "butler maintenance context",
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
    let positionals = positionals_without_options(args);
    matches!(positionals.first().map(String::as_str), Some("context"))
        || matches!(
            positionals.as_slice(),
            [maintenance, context, ..] if maintenance == "maintenance" && context == "context"
        )
}

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let (options, command) = match parse(&args) {
        Ok(parsed) => parsed,
        Err((command, error)) => return report_error(command, json_requested, &error),
    };
    let data_root =
        match settings_cli::resolve_data_root_override(options.data.clone(), &installation) {
            Ok(path) => path,
            Err(message) => {
                return report_error(
                    command.name(),
                    options.json,
                    &CliError::failed("butler_data_unavailable", message),
                );
            }
        };

    let result = match command {
        Command::Status => status::run(&data_root, &installation).await,
        Command::Compact => {
            compaction::run(&data_root, &installation, options.session.as_deref()).await
        }
        Command::Prune | Command::MaintenanceContext => {
            maintenance::run(&data_root, &installation).await
        }
    };
    match result {
        Ok((data, human)) => report_success(&options, command.name(), &data, &human),
        Err(error) => report_error(command.name(), options.json, &error),
    }
}

fn parse(args: &[OsString]) -> Result<(Options, Command), (&'static str, CliError)> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--session" => {
                let option = value.to_string();
                let raw = args
                    .get(index + 1)
                    .filter(|raw| !raw.to_string_lossy().starts_with("--"))
                    .ok_or_else(|| {
                        (
                            error_command(args),
                            CliError::invalid(format!("{option} requires a value")),
                        )
                    })?;
                let raw = raw.to_string_lossy().into_owned();
                if option == "--data" {
                    options.data = Some(PathBuf::from(raw));
                } else {
                    options.session = Some(raw);
                }
                index += 2;
                continue;
            }
            value if value.starts_with("--data=") => {
                options.data = Some(PathBuf::from(value[7..].to_owned()));
            }
            value if value.starts_with("--session=") => {
                options.session = Some(value[10..].to_owned());
            }
            "--home" => {
                return Err((
                    error_command(args),
                    CliError::invalid(
                        "--home is unsupported; native commands use installed resources and --data",
                    ),
                ));
            }
            "--json" => options.json = true,
            "--quiet" | "--silent" => options.quiet = true,
            "--yes" => options.yes = true,
            "--non-interactive" => options.non_interactive = true,
            "--verbose" => {}
            value if value.starts_with('-') => {
                return Err((
                    error_command(args),
                    CliError::invalid(format!("unsupported context option: {value}")),
                ));
            }
            _ => options.positionals.push(value.into_owned()),
        }
        index += 1;
    }

    let command = match options.positionals.as_slice() {
        [context] if context == "context" => Command::Status,
        [context, status] if context == "context" && status == "status" => Command::Status,
        [context, compact] if context == "context" && compact == "compact" => Command::Compact,
        [context, prune] if context == "context" && prune == "prune" => Command::Prune,
        [maintenance, context] if maintenance == "maintenance" && context == "context" => {
            Command::MaintenanceContext
        }
        [context, subcommand, ..] if context == "context" => {
            return Err((
                "butler context",
                CliError::invalid(format!(
                    "unknown context command: {subcommand}; supported commands: status, compact, prune"
                )),
            ));
        }
        [maintenance, context, ..] if maintenance == "maintenance" && context == "context" => {
            return Err((
                "butler maintenance context",
                CliError::invalid("maintenance context does not accept a subcommand"),
            ));
        }
        _ => {
            return Err((
                error_command(args),
                CliError::invalid(
                    "supported commands: context [status|compact|prune], maintenance context",
                ),
            ));
        }
    };
    if options.session.is_some() && command != Command::Compact {
        return Err((
            command.name(),
            CliError::invalid("--session is only supported by context compact"),
        ));
    }
    if command == Command::Compact {
        if !options.yes && !options.non_interactive {
            return Err((
                command.name(),
                CliError::invalid("context compact requires --yes"),
            ));
        }
        if options
            .session
            .as_deref()
            .is_none_or(|session| session.trim().is_empty())
        {
            return Err((
                command.name(),
                CliError::invalid("context compact requires --session SESSION_ID"),
            ));
        }
    }
    Ok((options, command))
}

fn positionals_without_options(args: &[OsString]) -> Vec<String> {
    let mut positionals = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--session" | "--home" => {
                index += if args.get(index + 1).is_some() { 2 } else { 1 };
            }
            "--json" | "--quiet" | "--silent" | "--yes" | "--non-interactive" | "--verbose" => {
                index += 1;
            }
            value if value.starts_with("--data=") || value.starts_with("--session=") => {
                index += 1;
            }
            value if value.starts_with('-') => index += 1,
            _ => {
                positionals.push(value.into_owned());
                index += 1;
            }
        }
    }
    positionals
}

fn error_command(args: &[OsString]) -> &'static str {
    match positionals_without_options(args).as_slice() {
        [context, ..] if context == "context" => "butler context",
        [maintenance, context, ..] if maintenance == "maintenance" && context == "context" => {
            "butler maintenance context"
        }
        _ => "butler context",
    }
}

fn validate_write_destination(
    installation: &ResolvedInstallation,
    path: &Path,
    reject_leaf_symlink: bool,
) -> Result<(), CliError> {
    installation
        .validate_data_root(path)
        .map_err(|_| CliError::failed("unsafe_path", "Context write destination is unsafe."))?;
    if reject_leaf_symlink {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(CliError::failed(
                    "unsafe_path",
                    "Context write destination is a symbolic link.",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(CliError::failed(
                    "unsafe_path",
                    "Context write destination cannot be inspected.",
                ));
            }
        }
    }
    Ok(())
}

async fn open_status_models(data_root: &Path) -> Result<models::NativeStatusModels, CliError> {
    models::open_status_models(data_root.to_path_buf())
        .await
        .map_err(|_| {
            unavailable(
                "native_context_models_unavailable",
                "Native model and context facts are unavailable.",
            )
        })
}

fn context_budget_owner(models: &models::NativeStatusModels) -> ContextBudgetOwner {
    ContextBudgetOwner::new(
        Arc::clone(&models.configuration),
        Arc::clone(&models.catalog),
        context_budget_environment(),
    )
}

fn context_budget_environment() -> ContextBudgetEnvironment {
    ContextBudgetEnvironment {
        context_window_tokens: env_value("BUTLER_CONTEXT_WINDOW_TOKENS"),
        reserved_output_tokens: env_value("BUTLER_CONTEXT_RESERVED_OUTPUT_TOKENS"),
        reserved_tool_tokens: env_value("BUTLER_CONTEXT_RESERVED_TOOL_TOKENS"),
        compaction_prompt_reserve_tokens: env_value(
            "BUTLER_CONTEXT_COMPACTION_PROMPT_RESERVE_TOKENS",
        ),
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn unavailable(code: &'static str, message: impl Into<String>) -> CliError {
    CliError::failed(code, message)
}

fn report_success(options: &Options, command: &str, data: &Value, human: &str) -> ExitCode {
    if options.json {
        println!(
            "{}",
            json!({
                "ok": true,
                "command": command,
                "data": data,
                "error": null,
                "privacy": { "rawTextIncluded": false, "secretsIncluded": false }
            })
        );
    } else if !options.quiet {
        println!("{human}");
    }
    ExitCode::SUCCESS
}

fn report_error(command: &str, json_output: bool, error: &CliError) -> ExitCode {
    if json_output {
        println!(
            "{}",
            json!({
                "ok": false,
                "command": command,
                "data": null,
                "error": { "code": error.code, "message": error.message },
                "privacy": { "rawTextIncluded": false, "secretsIncluded": false }
            })
        );
    } else {
        eprintln!("{}", error.message);
    }
    ExitCode::from(error.exit)
}
