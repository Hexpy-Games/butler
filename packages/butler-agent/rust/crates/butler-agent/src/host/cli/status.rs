//! Read-only native status commands; no service runtime or DATA initialization.

use butler_platform::secure_fs::Canonical as _;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::ExitCode,
};

use serde_json::{Value, json};

use crate::host::ResolvedInstallation;
use crate::host::service::instance as service_instance;
use butler_models::models;
use butler_runtime::operations;

#[derive(Default)]
struct Options {
    data: Option<String>,
    json: bool,
    quiet: bool,
    since_hours: Option<f64>,
    positionals: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Command {
    Status,
    ModelStatus,
}

impl Command {
    fn source_name(self) -> &'static str {
        match self {
            Self::Status => "butler status",
            Self::ModelStatus => "butler model status",
        }
    }
}

pub(crate) fn recognizes(args: &[OsString]) -> bool {
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--since-hours" => index += 2,
            "--json" | "--verbose" | "--quiet" | "--silent" | "--yes" | "--non-interactive" => {
                index += 1;
            }
            "--home" => {
                return args
                    .iter()
                    .any(|arg| matches!(arg.to_string_lossy().as_ref(), "status" | "model"));
            }
            value if value.starts_with('-') => return false,
            "status" | "model" => return true,
            _ => return false,
        }
    }
    false
}

pub(crate) async fn run_native_status_cli(
    installation: ResolvedInstallation,
    args: Vec<OsString>,
) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let (options, command) = match parse(&args) {
        Ok(parsed) => parsed,
        Err((name, message)) => return report_error(name, json_requested, &message),
    };
    let data_root = match resolve_data_root(&options, &installation) {
        Ok(path) => path,
        Err(message) => {
            return report_error(command.source_name(), options.json, message.message());
        }
    };
    let models = match models::open_status_models(data_root.clone()).await {
        Ok(models) => models,
        Err(error) => {
            return report_error(command.source_name(), options.json, &error.to_string());
        }
    };
    let (data, text) = match command {
        Command::ModelStatus => {
            let telemetry = operations::read_prompt_cache_telemetry(&data_root, None);
            let data = models.status_value(&telemetry.clone());
            let text = models.render_text(&telemetry, None);
            (data, text)
        }
        Command::Status => {
            let since_ts = options.since_hours.map(|hours| {
                butler_models::models::ModelConfigurationClock::now_epoch_millis(
                    &crate::host::SystemIdentity,
                ) as f64
                    - hours * 3_600_000.0
            });
            let metrics = operations::read_metrics_status(
                &data_root,
                since_ts,
                &models,
                installation.resources(),
            )
            .await;
            let model = models.status_value(&metrics.model_telemetry());
            let services = service_health(&data_root);
            let memory_model = super::status_memory::read(&data_root, &installation).await;
            let text = format!(
                "{}\n{}",
                operations::render_status_context(&metrics, &models, &services),
                super::status_memory::line(&memory_model)
            );
            (
                json!({ "status": metrics.value, "services": services, "model": model, "memoryModel": memory_model }),
                text,
            )
        }
    };

    if options.json {
        println!(
            "{}",
            json!({
                "ok": true,
                "command": command.source_name(),
                "data": data,
                "error": null,
                "privacy": { "rawTextIncluded": false, "secretsIncluded": false }
            })
        );
    } else if !options.quiet {
        println!("{text}");
    }
    ExitCode::SUCCESS
}

fn parse(args: &[OsString]) -> Result<(Options, Command), (&'static str, String)> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" => {
                let path = args
                    .get(index + 1)
                    .filter(|value| !value.to_string_lossy().starts_with('-'))
                    .ok_or(("butler status", "--data requires a path".to_owned()))?;
                options.data = Some(path.to_string_lossy().into_owned());
                index += 2;
                continue;
            }
            "--home" => {
                return Err((
                    "butler status",
                    "--home is unsupported; use --data for writable state".to_owned(),
                ));
            }
            "--since-hours" => {
                let raw = args
                    .get(index + 1)
                    .filter(|value| !value.to_string_lossy().starts_with("--"));
                options.since_hours = raw.and_then(|value| {
                    value
                        .to_string_lossy()
                        .parse::<f64>()
                        .ok()
                        .filter(|hours| hours.is_finite() && *hours >= 0.0)
                });
                index += if raw.is_some() { 2 } else { 1 };
                continue;
            }
            "--json" => options.json = true,
            "--quiet" | "--silent" => options.quiet = true,
            "--verbose" | "--yes" | "--non-interactive" => {}
            value if value.starts_with('-') => {
                return Err((
                    "butler status",
                    format!("unsupported status option: {value}"),
                ));
            }
            _ => options.positionals.push(value.into_owned()),
        }
        index += 1;
    }
    let command = match options.positionals.as_slice() {
        [status] if status == "status" => Command::Status,
        [model, status] if model == "model" && status == "status" => Command::ModelStatus,
        _ => {
            return Err((
                "butler status",
                "supported commands: status, model status".into(),
            ));
        }
    };
    Ok((options, command))
}

fn resolve_data_root(
    options: &Options,
    installation: &ResolvedInstallation,
) -> Result<PathBuf, crate::host::HostError> {
    let requested = options
        .data
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("BUTLER_DATA")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| butler_platform::user_dirs::home_dir().map(|home| home.join(".butler")))
        .ok_or_else(|| "native_home_unavailable".to_owned())?;
    let requested = expand_tilde(requested)?;
    installation.validate_data_root(&requested)
}

fn expand_tilde(path: PathBuf) -> Result<PathBuf, crate::host::HostError> {
    let Some(value) = path.to_str() else {
        return Ok(path);
    };
    if value != "~" && !value.starts_with("~/") {
        return Ok(path);
    }
    let home = butler_platform::user_dirs::non_empty_home_dir()
        .ok_or_else(|| "native_home_unavailable".to_owned())?;
    Ok(if value == "~" {
        home
    } else {
        home.join(&value[2..])
    })
}

fn service_health(data_root: &Path) -> Value {
    let record = service_instance::read_record(data_root);
    let locked = service_instance::instance_lock_is_held_read_only(data_root);
    let (status, evidence, pid, started_at, app) = match (record, locked) {
        (Err(_), _) | (_, Err(_)) => (
            "stale",
            "instance_identity_unavailable",
            Value::Null,
            Value::Null,
            json!({ "status": "unknown", "evidence": "instance_identity_unavailable" }),
        ),
        (Ok(None), Ok(false)) => (
            "offline",
            "no_instance_record",
            Value::Null,
            Value::Null,
            json!({ "status": "unknown", "evidence": "instance_not_observed" }),
        ),
        (Ok(None), Ok(true)) => (
            "stale",
            "lock_without_instance_record",
            Value::Null,
            Value::Null,
            json!({ "status": "unknown", "evidence": "instance_record_missing" }),
        ),
        (Ok(Some(record)), Ok(locked)) => {
            let matches = service_instance::process_matches(&record).unwrap_or(false);
            let current_executable = std::env::current_exe()
                .ok()
                .and_then(|path| path.canonical().ok());
            let executable_matches = current_executable.as_ref().is_some_and(|path| {
                Path::new(&record.executable).canonical().ok().as_ref() == Some(path)
            });
            let online = locked
                && matches
                && executable_matches
                && record.state == "ready"
                && record.ready_at.is_some();
            let state = if online { "online" } else { "stale" };
            let app_status = if record.app_enabled {
                json!({ "status": "unknown", "evidence": "independent_readiness_not_observed" })
            } else {
                json!({ "status": "disabled", "evidence": "configuration_disabled" })
            };
            (
                state,
                if online {
                    "kernel_lock_pid_start_and_executable_match"
                } else {
                    "record_not_ready_or_identity_mismatch"
                },
                json!(record.pid),
                record.ready_at.map_or(Value::Null, Value::String),
                app_status,
            )
        }
    };
    let item = json!({
        "serviceId": "butler-agent-native",
        "name": "butler-agent-native",
        "status": status,
        "pid": pid,
        "startedAt": started_at,
        "restartPolicy": "manual",
        "identityEvidence": evidence,
        "logicalRoles": {
            "agentRuntime": { "status": "unknown", "evidence": "independent_readiness_not_observed" },
            "appGateway": app
        }
    });
    json!({
        "summary": {
            "total": 1,
            "online": u8::from(status == "online"),
            "offline": u8::from(status == "offline"),
            "stale": u8::from(status == "stale")
        },
        "items": [item]
    })
}

fn report_error(command: &str, json_output: bool, message: &str) -> ExitCode {
    if json_output {
        println!(
            "{}",
            json!({
                "ok": false,
                "command": command,
                "data": null,
                "error": { "code": "native_status_cli_failed", "message": message },
                "privacy": { "rawTextIncluded": false, "secretsIncluded": false }
            })
        );
    } else {
        eprintln!("{message}");
    }
    ExitCode::from(1)
}
