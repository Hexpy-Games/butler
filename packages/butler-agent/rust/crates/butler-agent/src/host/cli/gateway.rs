//! Source-shaped Gateway App CLI over the native service-owned lifecycle.

use std::{ffi::OsString, path::PathBuf, process::ExitCode};

use serde_json::{Map, Value, json};

use crate::host::ResolvedInstallation;
use crate::host::service::configuration::AppServiceConfiguration;

mod allowed_hosts;
mod arguments;
mod control;
mod logs;
mod output;
mod settings;

use arguments::{Action, Options};

pub(crate) fn recognizes(args: &[OsString]) -> bool {
    arguments::recognizes(args)
}

pub(crate) async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let options = match arguments::parse(&args) {
        Ok(options) => options,
        Err(message) => return output::error("butler gateway", json_requested, message.message()),
    };
    if options.help {
        let usage = "gateway app|list|status [app]|inspect app|enable app|disable app|configure app [--host HOST] [--port PORT] [--db PATH] [--allowed-host NAME]... [--remove-allowed-host NAME]...|test app|start app|stop app|restart app|run app|logs app [--lines N] [--follow] [--json] [--data PATH]\n\nFor a tunnel or reverse proxy you run yourself, register its public host name with --allowed-host (for example `butler gateway configure app --allowed-host butler.example.com`). The gateway then accepts that name as Host and its http/https origins, so a proxy may pass the browser's Host and Origin through, or rewrite Host to 127.0.0.1:<port> and keep Origin. X-Forwarded-* and similar headers are never trusted for Host or client address; they only mark a request as forwarded, which Settings → Security refuses. Remote clients still need the connection code (token), and securing the tunnel is up to you. Tailscale addresses (100.64.0.0/10) are not bound by remote access: use `tailscale serve` to 127.0.0.1:<port> and register the tailnet name the same way. `butler gateway inspect app` lists the names.";
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
        Err(message) => return output::error("butler gateway", options.json, message.message()),
    };
    let data_root = match resolve_data(options.data.as_deref(), &installation) {
        Ok(path) => path,
        Err(message) => {
            return output::error(
                output::command_name(action),
                options.json,
                message.message(),
            );
        }
    };
    if let Err(message) =
        crate::host::service::instance::validate_write_destinations(&data_root, &installation)
    {
        return output::error(
            output::command_name(action),
            options.json,
            message.message(),
        );
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
        Err(message) => output::error(
            output::command_name(action),
            options.json,
            message.message(),
        ),
    }
}

async fn execute(
    action: Action,
    installation: &ResolvedInstallation,
    data_root: &std::path::Path,
    options: &Options,
) -> Result<Value, crate::host::HostError> {
    if matches!(action, Action::Logs) {
        return logs::read(data_root, installation, options.lines, options.follow);
    }
    let mut settings = settings::Settings::read(data_root, installation)?;
    let app = AppServiceConfiguration::capture(data_root);
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
        Action::Configure => configure(installation, data_root, options, &mut settings).await,
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
            let session = crate::host::service::entrypoint::run_native_service_with_options(
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

/// `gateway configure app`: the listener (`--host`, `--port`, `--db`, which
/// need a restart) and the allowed host names (applied live when the
/// service runs).
async fn configure(
    installation: &ResolvedInstallation,
    data_root: &std::path::Path,
    options: &Options,
    settings: &mut settings::Settings,
) -> Result<Value, crate::host::HostError> {
    let hosts_changed = !options.allowed_hosts.is_empty() || !options.removed_hosts.is_empty();
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
    if patch.is_empty() && !hosts_changed {
        return Err("gateway configure app requires --host, --port, --db, --allowed-host or --remove-allowed-host".into());
    }
    let mut applied_live = None;
    if hosts_changed {
        let current = AppServiceConfiguration::capture(data_root);
        let hosts = allowed_hosts::updated(
            current.allowed_hosts(),
            &options.allowed_hosts,
            &options.removed_hosts,
        )?;
        applied_live = Some(allowed_hosts::store(data_root, installation, hosts).await?);
    }
    if !patch.is_empty() {
        settings
            .patch(data_root, installation, Some(true), patch)
            .await?;
    }
    let refreshed = AppServiceConfiguration::capture(data_root);
    let mut view = status_value(
        Action::Configure,
        settings,
        &refreshed,
        installation,
        data_root,
    )
    .await?;
    if let Some(applied) = applied_live {
        view["allowedHostsApplied"] = Value::Bool(applied);
    }
    Ok(view)
}

/// Merges `patch` into `gateways/app.json` `config`, atomically and keeping
/// every other field; a missing file is created. Settings → Security saves
/// through here too.
pub(crate) async fn patch_app_config(
    data_root: &std::path::Path,
    installation: &ResolvedInstallation,
    patch: Map<String, Value>,
) -> Result<(), crate::host::HostError> {
    let mut settings = settings::Settings::read(data_root, installation)?;
    settings.patch(data_root, installation, None, patch).await
}

async fn status_value(
    action: Action,
    settings: &settings::Settings,
    app: &AppServiceConfiguration,
    installation: &ResolvedInstallation,
    data_root: &std::path::Path,
) -> Result<Value, crate::host::HostError> {
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

/// The App gateway URL of the ready service that owns `data_root`, if any.
/// A service that is still starting is waited for, up to `patience`.
pub(crate) async fn running_app_endpoint(
    data_root: &std::path::Path,
    installation: &ResolvedInstallation,
    patience: std::time::Duration,
) -> Result<Option<String>, crate::host::HostError> {
    let deadline = std::time::Instant::now() + patience;
    loop {
        let Some(record) = control::verified_instance(data_root, installation)? else {
            return Ok(None);
        };
        if record.state == "ready" || std::time::Instant::now() >= deadline {
            return Ok((record.state == "ready" && record.app_enabled)
                .then_some(record.app_endpoint)
                .flatten()
                .filter(|endpoint| !endpoint.is_empty()));
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

async fn start_service(
    installation: &ResolvedInstallation,
    data_root: &std::path::Path,
) -> Result<(), crate::host::HostError> {
    let code = crate::host::cli::service::run_native_service_cli(
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

/// The data folder `--data`, `BUTLER_DATA` or `~/.butler` names, validated
/// against the installation.
pub(crate) fn resolve_data(
    explicit: Option<&str>,
    installation: &ResolvedInstallation,
) -> Result<PathBuf, crate::host::HostError> {
    let home = butler_platform::user_dirs::non_empty_home_dir()
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
        .map_err(|source| {
            crate::host::HostError::new("native_path_configuration_invalid").with_source(source)
        })
}

fn expand_home_path(value: &str) -> PathBuf {
    let home = butler_platform::user_dirs::home_dir();
    match (value, home) {
        ("~", Some(home)) => home,
        (value, Some(home)) if value.starts_with("~/") => home.join(&value[2..]),
        _ => PathBuf::from(value),
    }
}
