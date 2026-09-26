//! One-shot native personalization commands; only Profile owns state changes.

mod commands;
mod composition;

use std::{ffi::OsString, path::PathBuf, process::ExitCode};

use serde_json::{Value, json};

use super::{ResolvedInstallation, settings_cli};

const PROFILE_MUTATION_PATHS: &[&str] = &[
    "personalization/profile.json",
    "cognition/profile/profile.sqlite",
    "cognition/profile/profile.sqlite-wal",
    "cognition/profile/profile.sqlite-shm",
    "cognition/profile/profile.sqlite-journal",
    "butler.config.json",
];

#[derive(Default)]
struct Options {
    data: Option<PathBuf>,
    json: bool,
    quiet: bool,
    positionals: Vec<OsString>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command {
    Show,
    Set,
    MigrationPrompt,
    MigrationImport,
    Unknown,
}

impl Command {
    fn parse(values: &[OsString]) -> Option<Self> {
        let family = values.first()?.to_string_lossy();
        if family != "personalization" {
            return None;
        }
        Some(match values.get(1).map(|value| value.to_string_lossy()) {
            None => Self::Show,
            Some(action) if action == "show" || action == "get" => Self::Show,
            Some(action) if action == "set" => Self::Set,
            Some(action) if action == "migration" || action == "migrate" => {
                match values.get(2).map(|value| value.to_string_lossy()) {
                    None => Self::MigrationPrompt,
                    Some(value) if value == "prompt" => Self::MigrationPrompt,
                    Some(value) if value == "import" => Self::MigrationImport,
                    _ => Self::Unknown,
                }
            }
            _ => Self::Unknown,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::Show => "butler personalization show",
            Self::Set => "butler personalization set",
            Self::MigrationPrompt => "butler personalization migration prompt",
            Self::MigrationImport => "butler personalization migration import",
            Self::Unknown => "butler personalization",
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
    Command::parse(&positionals_without_common_options(args)).is_some()
}

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let (options, _parsed_command) = match parse(&args) {
        Ok(parsed) => parsed,
        Err((command, error)) => return report_error(command, json_requested, &error),
    };
    let Some(command) = Command::parse(&options.positionals) else {
        return report_error(
            "butler personalization",
            options.json,
            &CliError::invalid("unsupported personalization command"),
        );
    };
    if command == Command::Unknown {
        let action = options
            .positionals
            .get(1)
            .map_or("", |value| value.to_str().unwrap_or("unknown"));
        return report_error(
            command.name(),
            options.json,
            &CliError {
                code: "unknown_command",
                message: if action == "migration" || action == "migrate" {
                    let nested = options
                        .positionals
                        .get(2)
                        .map_or("", |value| value.to_str().unwrap_or("unknown"));
                    format!("unknown personalization migration command: {nested}")
                } else {
                    format!("unknown personalization command: {action}")
                },
                exit: 2,
            },
        );
    }
    if command == Command::MigrationPrompt {
        return match commands::migration_prompt(&options) {
            Ok((data, human)) => report_success(&options, command.name(), &data, &human),
            Err(error) => report_error(command.name(), options.json, &error),
        };
    }

    let Ok(data_root) =
        settings_cli::resolve_data_root_override(options.data.clone(), &installation)
    else {
        return report_error(
            command.name(),
            options.json,
            &CliError::failed(
                "native_personalization_cli_failed",
                "Butler DATA is unavailable.",
            ),
        );
    };
    if matches!(command, Command::Set | Command::MigrationImport) {
        let mut paths = PROFILE_MUTATION_PATHS.to_vec();
        if command == Command::MigrationImport {
            paths.push("personalization/profile-imports");
        }
        if settings_cli::validate_data_mutation_paths(&data_root, &installation, &paths).is_err() {
            return report_error(
                command.name(),
                options.json,
                &CliError::failed(
                    "unsafe_path",
                    "personalization writes require non-symlink paths inside DATA",
                ),
            );
        }
    }
    let profile = match composition::open(
        &data_root,
        &installation,
        matches!(command, Command::Set | Command::MigrationImport),
    ) {
        Ok(profile) => profile,
        Err(message) => {
            return report_error(
                command.name(),
                options.json,
                &CliError::failed("native_personalization_cli_failed", message),
            );
        }
    };
    let result = match command {
        Command::Show => commands::show(&profile).await,
        Command::Set => commands::set(&options.positionals[2..], &profile).await,
        Command::MigrationImport => commands::import(&options.positionals[2..], &profile).await,
        // Answered before the profile opens; kept total so dispatch needs no panic.
        Command::MigrationPrompt | Command::Unknown => Err(CliError::failed(
            "unknown_command",
            "personalization command is not supported here",
        )),
    };
    profile.close().await;
    match result {
        Ok((data, human)) => report_success(&options, command.name(), &data, &human),
        Err(error) => report_error(command.name(), options.json, &error),
    }
}

fn parse(args: &[OsString]) -> Result<(Options, Command), (&'static str, CliError)> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        match args[index].to_string_lossy().as_ref() {
            "--data" => {
                let path = args
                    .get(index + 1)
                    .filter(|value| !value.to_string_lossy().starts_with("--"))
                    .filter(|value| !value.is_empty())
                    .ok_or((
                        "butler personalization",
                        CliError::invalid("--data requires a path"),
                    ))?;
                options.data = Some(PathBuf::from(path));
                index += 2;
            }
            "--home" => {
                return Err((
                    "butler personalization",
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
            "--verbose" | "--yes" | "--non-interactive" => index += 1,
            _ => {
                options.positionals.push(args[index].clone());
                index += 1;
            }
        }
    }
    let command = Command::parse(&options.positionals).ok_or((
        "butler personalization",
        CliError::invalid("unsupported personalization command"),
    ))?;
    Ok((options, command))
}

fn positionals_without_common_options(args: &[OsString]) -> Vec<OsString> {
    let mut values = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].to_string_lossy().as_ref() {
            "--data" | "--home" => index += 2,
            "--json" | "--quiet" | "--silent" | "--verbose" | "--yes" | "--non-interactive" => {
                index += 1;
            }
            _ => {
                values.push(args[index].clone());
                index += 1;
            }
        }
    }
    values
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
