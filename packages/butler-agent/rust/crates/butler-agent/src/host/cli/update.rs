//! The Agent package commands: `update` (check, dry run, apply), `install`,
//! `rollback` and `uninstall`. The App update check and dry run
//! live here too. None of them starts the App runtime.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::ExitCode,
};

use serde_json::{Value, json};

use crate::host::ResolvedInstallation;
use crate::host::cli::settings as settings_cli;
use butler_runtime::operations::{AppUpdateService, UpdateRequest};

mod agent;
mod context;
mod install_cmd;
mod report;
mod rollback_cmd;
mod uninstall_cmd;

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent command-line flags"
)]
#[derive(Default)]
struct Options {
    data: Option<PathBuf>,
    manifest: Option<String>,
    channel: Option<String>,
    json: bool,
    quiet: bool,
    dry_run: bool,
    check: bool,
    apply: bool,
    yes: bool,
    component: Option<String>,
    /// `install --from`: an archive path or URL.
    from: Option<String>,
    /// `install --sha256`: the archive's digest.
    sha256: Option<String>,
    /// `rollback --to`: a version or version directory.
    to: Option<String>,
    /// `uninstall --keep-data`: the default, spelled out.
    keep_data: bool,
    /// `uninstall --purge-data`: delete the data folder too.
    purge_data: bool,
    /// Do not restart the service on the new version.
    no_restart: bool,
    /// Write or remove service definitions without asking the service
    /// manager to load or unload them.
    files_only: bool,
    positionals: Vec<String>,
}

/// The verbs this family dispatches.
const VERBS: [&str; 4] = ["update", "install", "rollback", "uninstall"];

pub(crate) fn recognizes(args: &[OsString]) -> bool {
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].to_string_lossy();
        match arg.as_ref() {
            "--data" | "--component" | "--channel" | "--manifest" | "--home" | "--from"
            | "--sha256" | "--to" => index += 2,
            value if value.starts_with('-') => index += 1,
            value => return VERBS.contains(&value),
        }
    }
    false
}

pub(crate) async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let options = match parse(&args) {
        Ok(options) => options,
        Err(error) => return failure(json_requested, "invalid_arguments", error.message(), 2),
    };
    match options.positionals.as_slice() {
        [verb] if verb == "install" => install_cmd::run(installation, &options).await,
        [verb] if verb == "rollback" => rollback_cmd::run(installation, &options).await,
        [verb] if verb == "uninstall" => uninstall_cmd::run(installation, &options).await,
        [verb] if verb == "update" => Box::pin(update(installation, options)).await,
        _ => failure(
            options.json,
            "invalid_arguments",
            "update accepts --check or --dry-run",
            2,
        ),
    }
}

async fn update(installation: ResolvedInstallation, options: Options) -> ExitCode {
    let component = options.component.as_deref().unwrap_or("agent");
    if matches!(component, "agent" | "service" | "butler-agent") {
        return Box::pin(agent::run(installation, &options)).await;
    }
    if !matches!(component, "app" | "butler-app" | "app-server") {
        return failure(
            options.json,
            "unsupported_component",
            "unknown update component",
            2,
        );
    }
    Box::pin(app_update(installation, options)).await
}

/// The App update check and dry run.
async fn app_update(installation: ResolvedInstallation, options: Options) -> ExitCode {
    if options.apply || (!options.check && !options.dry_run) {
        return failure(
            options.json,
            "invalid_arguments",
            "choose --check or --dry-run; App apply is owned by the App updater",
            2,
        );
    }
    let Ok(data) = settings_cli::resolve_data_root_override(options.data.clone(), &installation)
    else {
        return failure(options.json, "unsafe_path", "BUTLER_DATA is unavailable", 1);
    };
    let service = match open_app_update(&data, &installation) {
        Ok(service) => service,
        Err(code) => {
            return failure(
                options.json,
                code.message(),
                "App updates are unavailable",
                1,
            );
        }
    };
    let request = UpdateRequest {
        component: Some("app".into()),
        manifest: options.manifest,
        channel: options.channel,
        dry_run: options.dry_run,
        ..UpdateRequest::default()
    };
    let result = if options.dry_run {
        Box::pin(service.apply(request)).await
    } else {
        service.check(request).await
    };
    service.close();
    match result {
        Ok(value) => {
            let status = if options.dry_run {
                &value
            } else {
                &value["components"][0]
            };
            let human = if options.dry_run {
                status["planned_actions"]
                    .as_array()
                    .map(|actions| {
                        actions
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default()
            } else {
                format!(
                    "Butler App {} → {}: {}",
                    status["current_version"].as_str().unwrap_or("?"),
                    status["available_version"].as_str().unwrap_or("?"),
                    if status["update_available"] == true {
                        "update available"
                    } else {
                        "up to date"
                    }
                )
            };
            if options.json {
                println!(
                    "{}",
                    json!({"ok":true,"command":"butler update","data":value})
                );
            } else if !options.quiet {
                println!("{human}");
            }
            ExitCode::SUCCESS
        }
        Err(error) => failure(options.json, error.code(), "App update check failed", 1),
    }
}

pub(in crate::host) fn open_app_update(
    data: &Path,
    installation: &ResolvedInstallation,
) -> Result<AppUpdateService, crate::host::HostError> {
    let data = installation.validate_data_root(data)?;
    let version = installation.app_version();
    AppUpdateService::new(data, installation.root().to_path_buf(), version)
        .map_err(|error| error.code().to_owned())
        .map_err(crate::host::HostError::from)
}

fn parse(args: &[OsString]) -> Result<Options, crate::host::HostError> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--manifest" | "--channel" | "--component" | "--from" | "--sha256"
            | "--to" => {
                let next = args
                    .get(index + 1)
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .filter(|arg| !arg.is_empty() && !arg.starts_with('-'))
                    .ok_or_else(|| format!("{value} requires a value"))?;
                match value.as_ref() {
                    "--data" => options.data = Some(next.into()),
                    "--manifest" => options.manifest = Some(next),
                    "--channel" => options.channel = Some(next),
                    "--from" => options.from = Some(next),
                    "--sha256" => options.sha256 = Some(next),
                    "--to" => options.to = Some(next),
                    _ => options.component = Some(next),
                }
                index += 2;
                continue;
            }
            "--check" => options.check = true,
            "--dry-run" => options.dry_run = true,
            "--json" => options.json = true,
            "--quiet" | "--silent" => options.quiet = true,
            "--verbose" | "--non-interactive" => {}
            "--home" => return Err("--home is unsupported; use --data".into()),
            "--apply" => options.apply = true,
            "--yes" => options.yes = true,
            "--keep-data" => options.keep_data = true,
            "--purge-data" => options.purge_data = true,
            "--no-restart" => options.no_restart = true,
            "--files-only" => options.files_only = true,
            flag if flag.starts_with('-') => return Err("unknown update option".into()),
            _ => options.positionals.push(value.into_owned()),
        }
        index += 1;
    }
    Ok(options)
}

fn failure(json_output: bool, code: &str, message: &str, exit: u8) -> ExitCode {
    if json_output {
        println!(
            "{}",
            json!({"ok":false,"command":"butler update","error":{"code":code,"message":message}})
        );
    } else {
        eprintln!("{code}: {message}");
    }
    ExitCode::from(exit)
}
