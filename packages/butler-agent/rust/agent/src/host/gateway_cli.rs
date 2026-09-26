//! Source-shaped Gateway App CLI over the native service-owned lifecycle.

use std::{ffi::OsString, path::PathBuf, process::ExitCode};

use serde_json::{Map, Value, json};

use super::{ResolvedInstallation, service_configuration::NativeAppServiceConfiguration};

mod arguments;
mod control;
mod logs;
mod output;
mod settings;

use arguments::{Action, Options};

pub fn recognizes(args: &[OsString]) -> bool {
    arguments::recognizes(args)
}

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let options = match arguments::parse(&args) {
        Ok(options) => options,
        Err(message) => return output::error("butler gateway", json_requested, &message),
    };
    if options.help {
        let usage = "gateway app|list|status [app]|inspect app|enable app|disable app|configure app [--host HOST] [--port PORT] [--db PATH]|test app|start app|stop app|restart app|run app|logs app [--lines N] [--follow] [--json] [--data PATH]";
        if options.json {
            println!(
                "{}",
                json!({"ok":true,"command":"butler gateway --help","data":{"usage":usage}})
            );
        } else if !options.quiet {
            println!("{usage}");
        }
        return ExitCode::SUCCESS;
    }
    let action = match arguments::action(&options.positionals) {
        Ok(action) => action,
        Err(message) => return output::error("butler gateway", options.json, &message),
    };
    let data_root = match resolve_data(options.data.as_deref(), &installation) {
        Ok(path) => path,
        Err(message) => {
            return output::error(output::command_name(action), options.json, &message);
        }
    };
    if let Err(message) =
        super::service_instance::validate_write_destinations(&data_root, &installation)
    {
        return output::error(output::command_name(action), options.json, &message);
    }
    let follow_logs =
        matches!(action, Action::Logs) && options.follow && !options.json && !options.quiet;
    match execute(action, &installation, &data_root, &options).await {
        Ok(value) => {
            if options.json {
                println!(
                    "{}",
                    json!({"ok":true,"command":output::command_name(action),"data":value})
                );
            } else if !options.quiet {
                println!("{}", output::render(action, &value));
            }
            if follow_logs {
                logs::follow(&data_root, &installation).await
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(message) => output::error(output::command_name(action), options.json, &message),
    }
}

async fn execute(
    action: Action,
    installation: &ResolvedInstallation,
    data_root: &std::path::Path,
    options: &Options,
) -> Result<Value, String> {
    if matches!(action, Action::Logs) {
        return logs::read(data_root, installation, options.lines, options.follow);
    }
    let mut settings = settings::Settings::read(data_root, installation)?;
    let app = NativeAppServiceConfiguration::capture(data_root);
    match action {
        Action::Enable | Action::Disable => {
            settings
                .patch(
                    data_root,
                    installation,
                    Some(matches!(action, Action::Enable)),
                    Map::new(),
                )
                .await?;
            status_value(action, &settings, &app, installation, data_root).await
        }
        Action::Configure => {
            if options.host.is_none() && options.port.is_none() && options.db_path.is_none() {
                return Err("gateway configure app requires --host, --port, or --db".into());
            }
            let mut patch = Map::new();
            if let Some(host) = &options.host {
                patch.insert("host".into(), Value::String(host.clone()));
            }
            if let Some(port) = options.port {
                patch.insert("port".into(), json!(port));
            }
            if let Some(db_path) = &options.db_path {
                patch.insert("dbPath".into(), Value::String(db_path.clone()));
            }
            settings
                .patch(data_root, installation, Some(true), patch)
                .await?;
            let refreshed = NativeAppServiceConfiguration::capture(data_root);
            status_value(action, &settings, &refreshed, installation, data_root).await
        }
        Action::List | Action::Status | Action::Inspect | Action::Test => {
            let view = status_value(action, &settings, &app, installation, data_root).await?;
            if matches!(action, Action::List) {
                Ok(json!({"gateways":[view]}))
            } else if matches!(action, Action::Inspect) {
                Ok(json!({
                    "id":view["id"], "title":view["title"],
                    "lifecycle":view["lifecycle"], "transport":view["transport"],
                    "enabled":view["enabled"], "configured":view["configured"],
                    "running":view["running"], "status":view["status"],
                    "restartRequired":view["restartRequired"],
                    "credentials":view["credentials"], "config":view["config"],
                    "nextActions":view["nextActions"],
                    "settingsStored":settings.updated(), "settingsPath":"gateways/app.json",
                }))
            } else {
                Ok(view)
            }
        }
        Action::Start | Action::Stop | Action::Restart => {
            if matches!(action, Action::Start | Action::Restart) && !app.enabled {
                let mut view = settings::local_view(&settings, &app, false, false);
                view[if matches!(action, Action::Start) {
                    "started"
                } else {
                    "restarted"
                }] = Value::Bool(false);
                view["reason"] = Value::String("disabled".into());
                return Ok(view);
            }
            let mut active = control::verified_instance(data_root, installation)?;
            if active
                .as_ref()
                .is_some_and(|record| record.state == "starting")
            {
                start_service(installation, data_root).await?;
                active = control::verified_instance(data_root, installation)?;
            }
            if active.is_none() && matches!(action, Action::Start | Action::Restart) {
                start_service(installation, data_root).await?;
                active = control::verified_instance(data_root, installation)?;
            }
            let Some(record) = active else {
                let mut view = settings::local_view(&settings, &app, false, false);
                match action {
                    Action::Stop => {
                        view["stopped"] = Value::Bool(true);
                        view["alreadyStopped"] = Value::Bool(true);
                    }
                    Action::Start => {
                        view["started"] = Value::Bool(false);
                        view["reason"] = Value::String("service_unavailable".into());
                    }
                    Action::Restart => {
                        view["restarted"] = Value::Bool(false);
                        view["reason"] = Value::String("service_unavailable".into());
                    }
                    _ => {}
                }
                return Ok(view);
            };
            let command = match action {
                Action::Start => "start",
                Action::Stop => "stop",
                Action::Restart => "restart",
                _ => return Err("gateway action does not control the service".into()),
            };
            let mut response = control::request(&record, command).await?;
            response["pid"] = json!(record.pid);
            Ok(response)
        }
        Action::Run | Action::App => {
            if !app.enabled {
                return Err(
                    "App gateway is disabled. Run `butler gateway enable app` first.".into(),
                );
            }
            if control::verified_instance(data_root, installation)?.is_some() {
                return Err("native service already owns this DATA; use gateway start app".into());
            }
            let session = super::native_service::run_native_service_with_options(
                installation.clone(),
                Some(data_root.to_string_lossy().into_owned()),
                false,
                options.quiet,
            )
            .await?;
            Ok(json!({"id":"app","running":false,"sessionId":session}))
        }
        // Logs are handled before gateway settings are opened.
        Action::Logs => Err("gateway logs are not read through settings".into()),
    }
}

async fn status_value(
    action: Action,
    settings: &settings::Settings,
    app: &NativeAppServiceConfiguration,
    installation: &ResolvedInstallation,
    data_root: &std::path::Path,
) -> Result<Value, String> {
    let current = control::verified_instance(data_root, installation)?;
    if let Some(record) = current.as_ref().filter(|record| record.state == "ready") {
        return control::request(
            record,
            if matches!(action, Action::Test) {
                "test"
            } else {
                "status"
            },
        )
        .await;
    }
    let running = current.as_ref().is_some_and(|record| {
        record.state == "ready"
            && record.app_enabled
            && record
                .app_endpoint
                .as_deref()
                .is_some_and(|value| !value.is_empty())
    });
    let mut view = settings::local_view(settings, app, running, false);
    if matches!(action, Action::Test) {
        view["ok"] = Value::Bool(false);
    }
    if matches!(action, Action::Inspect) {
        view["settingsStored"] = Value::Bool(settings.updated());
        view["settingsPath"] = Value::String("gateways/app.json".into());
    }
    Ok(view)
}

async fn start_service(
    installation: &ResolvedInstallation,
    data_root: &std::path::Path,
) -> Result<(), String> {
    let code = super::service_cli::run_native_service_cli(
        installation.clone(),
        vec![
            OsString::from("start"),
            OsString::from("--data"),
            OsString::from(data_root.as_os_str()),
            OsString::from("--quiet"),
        ],
    )
    .await;
    if code == ExitCode::SUCCESS {
        Ok(())
    } else {
        Err("native_service_start_failed".into())
    }
}

fn resolve_data(
    explicit: Option<&str>,
    installation: &ResolvedInstallation,
) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "native_home_unavailable".to_owned())?;
    let requested = explicit
        .map(expand_home_path)
        .or_else(|| {
            std::env::var_os("BUTLER_DATA")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| home.join(".butler"));
    installation
        .validate_data_root(&requested)
        .map_err(|_| "native_path_configuration_invalid".to_owned())
}

fn expand_home_path(value: &str) -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match (value, home) {
        ("~", Some(home)) => home,
        (value, Some(home)) if value.starts_with("~/") => home.join(&value[2..]),
        _ => PathBuf::from(value),
    }
}
