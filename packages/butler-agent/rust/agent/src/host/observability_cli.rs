//! One-shot native metrics, logs and physical process inspection commands.

mod logs;
mod metrics;
mod path;
mod process;

use std::{ffi::OsString, path::PathBuf, process::ExitCode};

use serde_json::{Value, json};

use super::ResolvedInstallation;

#[derive(Default)]
pub(super) struct Options {
    pub(super) data: Option<PathBuf>,
    pub(super) json: bool,
    pub(super) quiet: bool,
    pub(super) follow: bool,
    pub(super) lines: Option<usize>,
    pub(super) service: Option<String>,
    pub(super) since_hours: Option<f64>,
    positionals: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command {
    MetricsEnable,
    MetricsDisable,
    MetricsTail,
    Logs,
    Ps,
}

impl Command {
    fn parse(positionals: &[String]) -> Option<Self> {
        match positionals {
            [metrics, action, ..] if metrics == "metrics" => match action.as_str() {
                "enable" => Some(Self::MetricsEnable),
                "disable" => Some(Self::MetricsDisable),
                "tail" => Some(Self::MetricsTail),
                _ => None,
            },
            [logs, ..] if logs == "logs" => Some(Self::Logs),
            [ps, ..] if ps == "ps" => Some(Self::Ps),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::MetricsEnable => "butler metrics enable",
            Self::MetricsDisable => "butler metrics disable",
            Self::MetricsTail => "butler metrics tail",
            Self::Logs => "butler logs",
            Self::Ps => "butler ps",
        }
    }
}

pub fn recognizes(args: &[OsString]) -> bool {
    Command::parse(&positionals_without_options(args)).is_some()
}

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let (options, command) = match parse(&args) {
        Ok((options, Some(command))) => (options, command),
        Ok((_, None)) => {
            return report_error(
                "butler observability",
                json_requested,
                "invalid_arguments",
                "supported commands: metrics enable|disable|tail, logs, ps",
                2,
            );
        }
        Err(message) => {
            return report_error(
                error_command(&args),
                json_requested,
                "invalid_arguments",
                &message,
                2,
            );
        }
    };
    let data_root = match path::resolve_data_root(&options, &installation) {
        Ok(path) => path,
        Err(message) => {
            return report_error(command.name(), options.json, "unsafe_path", &message, 1);
        }
    };
    match command {
        Command::MetricsEnable | Command::MetricsDisable => {
            metrics::set_enabled(&options, command, &data_root, &installation).await
        }
        Command::MetricsTail => metrics::tail(&options, &data_root, &installation),
        Command::Logs => logs::run(options, data_root, installation).await,
        Command::Ps => process::run(&options, &data_root),
    }
}

fn parse(args: &[OsString]) -> Result<(Options, Option<Command>), String> {
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
            "--lines" => {
                let raw = required_value(args, index, "--lines")?.to_string_lossy();
                options.lines = raw.parse::<usize>().ok().filter(|count| *count > 0);
                index += 2;
            }
            "--service" => {
                options.service = Some(
                    required_value(args, index, "--service")?
                        .to_string_lossy()
                        .into_owned(),
                );
                index += 2;
            }
            "--since-hours" => {
                options.since_hours = required_value(args, index, "--since-hours")?
                    .to_string_lossy()
                    .parse::<f64>()
                    .ok()
                    .filter(|hours| hours.is_finite() && *hours > 0.0);
                index += 2;
            }
            "--home" => return Err("--home is unsupported; use --data for writable state".into()),
            "--json" => {
                options.json = true;
                index += 1;
            }
            "--quiet" | "--silent" => {
                options.quiet = true;
                index += 1;
            }
            "--follow" => {
                options.follow = true;
                index += 1;
            }
            "--verbose" | "--yes" | "--non-interactive" => index += 1,
            value if value.starts_with('-') => return Err(format!("unsupported option: {value}")),
            _ => {
                options.positionals.push(value.into_owned());
                index += 1;
            }
        }
    }
    let command = Command::parse(&options.positionals);
    if let Some(command) = command
        && options.positionals.len() != command_position_count(command)
    {
        return Err("unexpected command argument".into());
    }
    Ok((options, command))
}

fn command_position_count(command: Command) -> usize {
    if matches!(command, Command::Logs | Command::Ps) {
        1
    } else {
        2
    }
}

fn required_value<'a>(
    args: &'a [OsString],
    index: usize,
    name: &str,
) -> Result<&'a OsString, String> {
    args.get(index + 1)
        .filter(|value| !value.to_string_lossy().starts_with("--"))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} requires a value"))
}

fn error_command(args: &[OsString]) -> &'static str {
    Command::parse(&positionals_without_options(args)).map_or("butler observability", Command::name)
}

fn positionals_without_options(args: &[OsString]) -> Vec<String> {
    let mut values = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--lines" | "--service" | "--since-hours" => {
                index += if args
                    .get(index + 1)
                    .is_some_and(|next| !next.to_string_lossy().starts_with("--"))
                {
                    2
                } else {
                    1
                };
            }
            "--json" | "--quiet" | "--silent" | "--follow" | "--verbose" | "--yes"
            | "--non-interactive" | "--home" => index += 1,
            option if option.starts_with('-') => index += 1,
            _ => {
                values.push(value.into_owned());
                index += 1;
            }
        }
    }
    values
}

pub(super) fn report_success(options: &Options, command: &str, data: &Value, human: &str) {
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
}

pub(super) fn report_error(
    command: &str,
    json_output: bool,
    code: &str,
    message: &str,
    exit: u8,
) -> ExitCode {
    if json_output {
        println!(
            "{}",
            json!({
                "ok": false,
                "command": command,
                "data": null,
                "error": { "code": code, "message": message },
                "privacy": { "rawTextIncluded": false, "secretsIncluded": false }
            })
        );
    } else {
        eprintln!("{message}");
    }
    ExitCode::from(exit)
}

pub(super) fn clamp_lines(options: &Options, default: usize, maximum: usize) -> usize {
    options.lines.unwrap_or(default).min(maximum)
}
