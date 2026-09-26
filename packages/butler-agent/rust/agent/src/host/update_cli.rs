//! One-shot App package update check and dry run; never starts the App runtime.

use std::{ffi::OsString, path::PathBuf, process::ExitCode};

use serde_json::{Value, json};

use super::{ResolvedInstallation, settings_cli};
use crate::operations::{AppUpdateService, UpdateRequest};

mod agent;

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
    positionals: Vec<String>,
}

pub fn recognizes(args: &[OsString]) -> bool {
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].to_string_lossy();
        match arg.as_ref() {
            "--data" | "--component" | "--channel" | "--manifest" | "--home" => index += 2,
            value if value.starts_with('-') => index += 1,
            value => return value == "update",
        }
    }
    false
}

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let options = match parse(&args) {
        Ok(options) => options,
        Err(error) => return failure(json_requested, "invalid_arguments", &error, 2),
    };
    if options.positionals != ["update"] {
        return failure(
            options.json,
            "invalid_arguments",
            "update accepts --check or --dry-run",
            2,
        );
    }
    let component = options.component.as_deref().unwrap_or("agent");
    if matches!(component, "agent" | "service" | "butler-agent") {
        return agent::run(installation, &options).await;
    }
    if !matches!(component, "app" | "butler-app" | "app-server") {
        return failure(
            options.json,
            "unsupported_component",
            "unknown update component",
            2,
        );
    }
    if options.apply || (!options.check && !options.dry_run) {
        return failure(
            options.json,
            "invalid_arguments",
            "choose --check or --dry-run; App apply is owned by the App updater",
            2,
        );
    }
    let data = match settings_cli::resolve_data_root_override(options.data.clone(), &installation) {
        Ok(data) => data,
        Err(_) => return failure(options.json, "unsafe_path", "BUTLER_DATA is unavailable", 1),
    };
    let service = match open_app_update(data, &installation) {
        Ok(service) => service,
        Err(code) => return failure(options.json, &code, "App updates are unavailable", 1),
    };
    let request = UpdateRequest {
        component: Some("app".into()),
        manifest: options.manifest,
        channel: options.channel,
        dry_run: options.dry_run,
        ..UpdateRequest::default()
    };
    let result = if options.dry_run {
        service.apply(request).await
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
        Err(code) => failure(options.json, &code, "App update check failed", 1),
    }
}

pub(super) fn open_app_update(
    data: PathBuf,
    installation: &ResolvedInstallation,
) -> Result<AppUpdateService, String> {
    let data = installation.validate_data_root(&data)?;
    let version = installation.app_version();
    AppUpdateService::new(data, installation.root().to_path_buf(), version)
}

fn parse(args: &[OsString]) -> Result<Options, String> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--manifest" | "--channel" | "--component" => {
                let next = args
                    .get(index + 1)
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .filter(|arg| !arg.is_empty() && !arg.starts_with('-'))
                    .ok_or_else(|| format!("{value} requires a value"))?;
                match value.as_ref() {
                    "--data" => options.data = Some(next.into()),
                    "--manifest" => options.manifest = Some(next),
                    "--channel" => options.channel = Some(next),
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
