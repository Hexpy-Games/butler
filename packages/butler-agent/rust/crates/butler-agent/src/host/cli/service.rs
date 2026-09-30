//! Native `service` CLI parsing and output; lifecycle effects live separately.

use std::process::ExitCode;
use std::{ffi::OsString, path::Path};

use serde_json::json;

use crate::host::ResolvedInstallation;
use crate::host::service::instance::{
    AdmissionLock, InstanceRecord, RestartIdentity, StopRequester,
};

mod lifecycle;
mod registration;

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
    /// `--if-absent`: `service run` exits 0 when an instance owns DATA already.
    if_absent: bool,
    /// `--files-only`: `service install` and `uninstall` write or remove the
    /// definition without asking the service manager to act.
    files_only: bool,
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
    /// `service install`: register the service to start at login.
    RegisterLogin,
    /// `service uninstall`: remove that registration.
    UnregisterLogin,
    /// `service status`: what the service manager says about it.
    LoginStatus,
}

impl Action {
    fn name(self) -> &'static str {
        match self {
            Self::Run => "service run",
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::RestartHandoff => "service restart-handoff",
            Self::RegisterLogin => "service install",
            Self::UnregisterLogin => "service uninstall",
            Self::LoginStatus => "service status",
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
            | "--dry-run" | "--detached" | "--if-absent" | "--files-only" => {
                saw_option = true;
                index += 1;
            }
            value if value.starts_with("--port=") => {
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
    if let Some((command, message)) = misplaced_option(&options, action) {
        return report_error(command, options.json, message);
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
    if matches!(
        action,
        Action::RegisterLogin | Action::UnregisterLogin | Action::LoginStatus
    ) {
        return registration::run(action, &installation, data.as_deref(), &options);
    }
    if options.if_absent && lifecycle::already_running(data.as_deref(), &installation) {
        if !options.quiet {
            println!("Butler native service is already running");
        }
        return ExitCode::SUCCESS;
    }
    if matches!(action, Action::Run) {
        return run_service(installation, data, &options).await;
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

/// An option that does not belong to the action: the command to report it
/// under and what is wrong.
fn misplaced_option(options: &Options, action: Action) -> Option<(&'static str, &'static str)> {
    let run = matches!(action, Action::Run);
    if options.dry_run && run {
        Some(("service run", "--dry-run is not supported for service run"))
    } else if (options.detached || options.if_absent) && !run {
        Some((
            "service",
            "--detached and --if-absent are only valid for service run",
        ))
    } else if options.files_only
        && !matches!(action, Action::RegisterLogin | Action::UnregisterLogin)
    {
        Some((
            "service",
            "--files-only is only valid for service install and uninstall",
        ))
    } else {
        None
    }
}

/// `service run`: the foreground service, until it is asked to stop.
async fn run_service(
    installation: ResolvedInstallation,
    data: Option<String>,
    options: &Options,
) -> ExitCode {
    match crate::host::service::entrypoint::run_native_service_with_options(
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
            } else if let Some(session) = session.filter(|_| !options.quiet) {
                println!("{session}");
            }
            ExitCode::SUCCESS
        }
        Err(message) => report_error("service run", options.json, message.message()),
    }
}

/// The instance that owns `data_root`, if one is starting or ready.
pub(super) fn running_instance(
    data_root: &Path,
) -> Result<Option<InstanceRecord>, crate::host::HostError> {
    lifecycle::active_service(data_root)
}

/// Holds the DATA admission lock: while the guard lives, no controller
/// starts, stops or restarts the service of `data_root`.
pub(super) async fn admit(
    installation: &ResolvedInstallation,
    data_root: &Path,
) -> Result<AdmissionLock, crate::host::HostError> {
    lifecycle::acquire_admission(data_root, installation).await
}

/// Stops the service that owns `data_root` (the stop-intent `stop`, asked by
/// the CLI) and reports what it did.
pub(super) async fn stop_running(
    installation: ResolvedInstallation,
    data_root: &Path,
) -> Result<serde_json::Value, crate::host::HostError> {
    let data = data_root.to_string_lossy().into_owned();
    lifecycle::execute(
        Action::Stop,
        installation,
        Some(&data),
        Options::default().control(),
    )
    .await
}

pub(crate) fn spawn_restart_handoff(
    installation: &ResolvedInstallation,
    data_root: &Path,
    expected: &RestartIdentity,
    intent_id: &str,
) -> Result<(), crate::host::HostError> {
    if lifecycle::asked_of_manager(data_root, expected) {
        return Ok(());
    }
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
            // The service configuration reads harness port overrides from argv.
            value if value.starts_with("--port=") => {}
            "--verbose" | "--yes" | "--non-interactive" => {}
            "--dry-run" => options.dry_run = true,
            "--detached" => options.detached = true,
            "--if-absent" => options.if_absent = true,
            "--files-only" => options.files_only = true,
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
        [service, command] if service == "service" && command == "install" => Action::RegisterLogin,
        [service, command] if service == "service" && command == "uninstall" => {
            Action::UnregisterLogin
        }
        [service, command] if service == "service" && command == "status" => Action::LoginStatus,
        [service] if service == "service" => {
            return Err(
                "supported commands: service run|install|uninstall|status, start, stop, restart"
                    .into(),
            );
        }
        [command] if command == "start" => Action::Start,
        [command] if command == "stop" => Action::Stop,
        [command] if command == "restart" => Action::Restart,
        _ => return Err("unexpected service arguments".into()),
    };
    if !matches!(action, Action::Run)
        && args
            .iter()
            .any(|arg| arg.to_string_lossy().starts_with("--port="))
    {
        return Err("--port= is only supported for service run".into());
    }
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
    let home = butler_platform::user_dirs::home_dir()
        .filter(|home| !home.as_os_str().is_empty())
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
