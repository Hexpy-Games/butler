//! Native `service` CLI parsing and output; lifecycle effects live separately.

use std::process::ExitCode;
use std::{ffi::OsString, path::Path};

use serde_json::json;

use crate::host::ResolvedInstallation;
use crate::host::service::instance::{RestartIdentity, StopRequester};

mod lifecycle;

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent command-line flags"
)]
#[derive(Default)]
struct Options {
    data: Option<String>,
    json: bool,
    quiet: bool,
    dry_run: bool,
    detached: bool,
    /// `--requested-by`: the controller recorded in the stop intent.
    requested_by: Option<StopRequester>,
    positionals: Vec<String>,
}

impl Options {
    fn control(&self) -> lifecycle::ControlOptions {
        lifecycle::ControlOptions {
            dry_run: self.dry_run,
            requested_by: self.requested_by.unwrap_or_default(),
        }
    }
}

#[derive(Clone, Copy)]
enum Action {
    Run,
    Start,
    Stop,
    Restart,
    RestartHandoff,
}

impl Action {
    fn name(self) -> &'static str {
        match self {
            Self::Run => "service run",
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::RestartHandoff => "service restart-handoff",
        }
    }
}

pub(crate) fn recognizes(args: &[OsString]) -> bool {
    let mut index = 0;
    let mut saw_option = false;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--home" | "--requested-by" => {
                saw_option = true;
                index += 2;
            }
            "--json" | "--verbose" | "--quiet" | "--silent" | "--yes" | "--non-interactive"
            | "--dry-run" | "--detached" => {
                saw_option = true;
                index += 1;
            }
            value if value.starts_with('-') => return false,
            "service" | "start" | "stop" | "restart" => return true,
            _ => return false,
        }
    }
    saw_option
}

pub(crate) async fn run_native_service_cli(
    installation: ResolvedInstallation,
    args: Vec<OsString>,
) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let parsed = parse(&args);
    let (options, action) = match parsed {
        Ok(value) => value,
        Err(message) => return report_error("service", json_requested, message.message()),
    };
    if options.dry_run && matches!(action, Action::Run) {
        return report_error(
            "service run",
            options.json,
            "--dry-run is not supported for service run",
        );
    }
    if options.detached && !matches!(action, Action::Run) {
        return report_error(
            "service",
            options.json,
            "--detached is only valid for service run",
        );
    }
    let data = match expand_data(options.data.as_deref()) {
        Ok(data) => data,
        Err(message) => return report_error("service", options.json, message.message()),
    };
    if matches!(action, Action::RestartHandoff) {
        if options.dry_run {
            return report_error(
                action.name(),
                options.json,
                "restart handoff does not support dry-run",
            );
        }
        let Some(data) = data.as_deref() else {
            return report_error(
                action.name(),
                options.json,
                "restart handoff requires --data",
            );
        };
        return match lifecycle::execute_restart_handoff(installation, data).await {
            Ok(_) => ExitCode::SUCCESS,
            Err(message) => report_error(action.name(), options.json, message.message()),
        };
    }
    if matches!(action, Action::Run) {
        return match crate::host::service::entrypoint::run_native_service_with_options(
            installation,
            data,
            options.detached,
            options.quiet,
        )
        .await
        {
            Ok(session) => {
                if options.json {
                    println!(
                        "{}",
                        json!({"ok":true,"command":"service run","data":{"sessionId":session}})
                    );
                } else if !options.quiet {
                    println!("{session}");
                }
                ExitCode::SUCCESS
            }
            Err(message) => report_error("service run", options.json, message.message()),
        };
    }
    let result = lifecycle::execute(action, installation, data.as_deref(), options.control()).await;
    match result {
        Ok(value) => {
            if options.json {
                println!(
                    "{}",
                    json!({"ok":true,"command":action.name(),"data":value})
                );
            } else if !options.quiet {
                println!("{}", lifecycle::summary(action, &value));
            }
            ExitCode::SUCCESS
        }
        Err(message) => report_error(action.name(), options.json, message.message()),
    }
}

pub(crate) fn spawn_restart_handoff(
    installation: &ResolvedInstallation,
    data_root: &Path,
    expected: &RestartIdentity,
    intent_id: &str,
) -> Result<(), crate::host::HostError> {
    lifecycle::spawn_restart_handoff(installation, data_root, expected, intent_id)
}

fn parse(args: &[OsString]) -> Result<(Options, Action), crate::host::HostError> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        let consumes_value = value == "--data" || value == "--requested-by";
        match value.as_ref() {
            "--data" => {
                let path = args
                    .get(index + 1)
                    .filter(|value| !value.to_string_lossy().starts_with('-'))
                    .ok_or_else(|| "--data requires a path".to_owned())?;
                options.data = Some(path.to_string_lossy().into_owned());
                index += 2;
            }
            "--requested-by" => {
                let requester = args
                    .get(index + 1)
                    .and_then(|value| StopRequester::parse(&value.to_string_lossy()))
                    .ok_or_else(|| "--requested-by requires cli, app or mcp".to_owned())?;
                options.requested_by = Some(requester);
                index += 2;
            }
            "--home" => return Err("--home is unsupported; use --data for writable state".into()),
            "--json" => options.json = true,
            "--quiet" | "--silent" => options.quiet = true,
            "--verbose" | "--yes" | "--non-interactive" => {}
            "--dry-run" => options.dry_run = true,
            "--detached" => options.detached = true,
            value if value.starts_with('-') => {
                return Err(format!("unsupported service option: {value}").into());
            }
            _ => options.positionals.push(value.into_owned()),
        }
        if !consumes_value {
            index += 1;
        }
    }
    let action = match options.positionals.as_slice() {
        [] => Action::Run,
        [service, command] if service == "service" && command == "run" => Action::Run,
        [service, command] if service == "service" && command == "restart-handoff" => {
            Action::RestartHandoff
        }
        [service] if service == "service" => {
            return Err("supported commands: service run, start, stop, restart".into());
        }
        [command] if command == "start" => Action::Start,
        [command] if command == "stop" => Action::Stop,
        [command] if command == "restart" => Action::Restart,
        _ => return Err("unexpected service arguments".into()),
    };
    if matches!(action, Action::RestartHandoff) && options.data.is_none() {
        return Err("service restart-handoff requires --data".into());
    }
    if options.requested_by.is_some() && !matches!(action, Action::Stop | Action::Restart) {
        return Err("--requested-by is only valid for stop and restart".into());
    }
    Ok((options, action))
}

fn expand_data(data: Option<&str>) -> Result<Option<String>, crate::host::HostError> {
    let Some(data) = data else { return Ok(None) };
    let home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "native_home_unavailable".to_owned())?;
    let expanded = if data == "~" {
        home
    } else if let Some(suffix) = data.strip_prefix("~/") {
        home.join(suffix)
    } else {
        std::path::PathBuf::from(data)
    };
    Ok(Some(expanded.to_string_lossy().into_owned()))
}

fn report_error(command: &str, json_output: bool, message: &str) -> ExitCode {
    if json_output {
        eprintln!(
            "{}",
            json!({"ok":false,"command":command,"error":{"code":"native_service_cli_failed","message":message}})
        );
    } else {
        eprintln!("{message}");
    }
    ExitCode::from(1)
}

#[cfg(test)]
mod tests;
