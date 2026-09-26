//! One-shot settings commands; read paths do not initialize DATA or start runtime.

mod auth_model;
mod config;
mod config_commands;
mod path;
#[cfg(test)]
#[path = "settings_cli/tests.rs"]
mod tests;

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::ExitCode,
};

use serde_json::{Value, json};

use super::ResolvedInstallation;

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent command-line flags"
)]
#[derive(Default)]
struct Options {
    data: Option<PathBuf>,
    json: bool,
    quiet: bool,
    yes: bool,
    non_interactive: bool,
    positionals: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Command {
    ConfigGet,
    ConfigSet,
    ConfigEdit,
    ConfigValidate,
    AuthStatus,
    AuthLogin,
    AuthLogout,
    ModelList,
    ModelSet,
}

impl Command {
    fn from_positionals(values: &[String]) -> Option<Self> {
        match values {
            [family, action, ..] if family == "config" => match action.as_str() {
                "get" => Some(Self::ConfigGet),
                "set" => Some(Self::ConfigSet),
                "edit" => Some(Self::ConfigEdit),
                "validate" => Some(Self::ConfigValidate),
                _ => None,
            },
            [family, action, ..] if family == "auth" => match action.as_str() {
                "status" => Some(Self::AuthStatus),
                "login" => Some(Self::AuthLogin),
                "logout" => Some(Self::AuthLogout),
                _ => None,
            },
            [family, action, ..] if family == "model" => match action.as_str() {
                "list" => Some(Self::ModelList),
                "set" => Some(Self::ModelSet),
                _ => None,
            },
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::ConfigGet => "butler config get",
            Self::ConfigSet => "butler config set",
            Self::ConfigEdit => "butler config edit",
            Self::ConfigValidate => "butler config validate",
            Self::AuthStatus => "butler auth status",
            Self::AuthLogin => "butler auth login",
            Self::AuthLogout => "butler auth logout",
            Self::ModelList => "butler model list",
            Self::ModelSet => "butler model set",
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

    fn health(message: impl Into<String>) -> Self {
        Self {
            code: "health_failed",
            message: message.into(),
            exit: 3,
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
    let values = positionals_without_common_options(args);
    Command::from_positionals(&values).is_some()
}

pub(super) fn resolve_data_root_override(
    data: Option<PathBuf>,
    installation: &ResolvedInstallation,
) -> Result<PathBuf, String> {
    path::resolve_data_root(
        &Options {
            data,
            ..Options::default()
        },
        installation,
    )
}

pub(super) fn validate_data_mutation_paths(
    data_root: &std::path::Path,
    installation: &ResolvedInstallation,
    requested: &[&str],
) -> Result<(), String> {
    path::validate_data_mutation_paths(installation, data_root, requested)
        .map_err(|error| error.message)
}

pub(super) fn validate_absolute_data_mutation_paths(
    data_root: &Path,
    installation: &ResolvedInstallation,
    requested: &[&Path],
) -> Result<(), String> {
    path::validate_absolute_data_mutation_paths(installation, data_root, requested)
        .map_err(|error| error.message)
}

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let parsed = parse(&args);
    let (options, command) = match parsed {
        Ok(parsed) => parsed,
        Err((command, error)) => return report_error(command, json_requested, &error),
    };
    let data_root = match path::resolve_data_root(&options, &installation) {
        Ok(path) => path,
        Err(message) => {
            return report_error(
                command.name(),
                options.json,
                &CliError::failed("native_settings_cli_failed", message),
            );
        }
    };

    match command {
        Command::ConfigGet => {
            config_commands::config_get(&options, command, &data_root, &installation)
        }
        Command::ConfigSet => {
            config_commands::config_set(&options, command, &data_root, &installation)
        }
        Command::ConfigEdit => {
            config_commands::config_edit(&options, command, &data_root, &installation)
        }
        Command::ConfigValidate => {
            config_commands::config_validate(&options, command, &data_root, &installation)
        }
        Command::AuthStatus => {
            auth_model::auth_status(&options, command, &data_root, &installation)
        }
        Command::AuthLogin => {
            auth_model::auth_login(options, command, data_root, installation).await
        }
        Command::AuthLogout => {
            auth_model::auth_logout(&options, command, &data_root, &installation).await
        }
        Command::ModelList => auth_model::model_list(&options, command),
        Command::ModelSet => {
            auth_model::model_set(&options, command, &data_root, &installation).await
        }
    }
}

fn parse(args: &[OsString]) -> Result<(Options, Command), (&'static str, CliError)> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" => {
                let path = args
                    .get(index + 1)
                    .filter(|value| !value.to_string_lossy().starts_with("--"))
                    .filter(|value| !value.is_empty())
                    .ok_or((
                        error_command(args),
                        CliError::invalid("--data requires a path"),
                    ))?;
                options.data = Some(PathBuf::from(path));
                index += 2;
                continue;
            }
            "--home" => {
                return Err((
                    error_command(args),
                    CliError::invalid("--home is unsupported; use --data for writable state"),
                ));
            }
            "--json" => options.json = true,
            "--quiet" | "--silent" => options.quiet = true,
            "--yes" => options.yes = true,
            "--non-interactive" => options.non_interactive = true,
            "--verbose" => {}
            _ => options.positionals.push(value.into_owned()),
        }
        index += 1;
    }
    let command = Command::from_positionals(&options.positionals).ok_or((
        error_command(args),
        CliError::invalid("unsupported settings command"),
    ))?;
    Ok((options, command))
}

fn positionals_without_common_options(args: &[OsString]) -> Vec<String> {
    let mut values = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--home" => {
                if args
                    .get(index + 1)
                    .is_some_and(|value| !value.to_string_lossy().starts_with("--"))
                {
                    index += 2;
                } else {
                    index += 1;
                }
            }
            "--json" | "--quiet" | "--silent" | "--yes" | "--non-interactive" | "--verbose" => {
                index += 1;
            }
            _ => {
                values.push(value.into_owned());
                index += 1;
            }
        }
    }
    values
}

fn error_command(args: &[OsString]) -> &'static str {
    Command::from_positionals(&positionals_without_common_options(args))
        .map_or("butler settings", Command::name)
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
