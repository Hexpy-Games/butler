//! Detached launch, identity-checked stop, and readiness for the native service.

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use butler_platform::{process_control, secure_fs, user_dirs};
use serde_json::{Value, json};

use super::Action;
use crate::host::service::instance::{
    AdmissionLock, InstanceRecord, StopReason, StopRequest, StopRequester, instance_is_locked,
    process_matches, read_record, record_process_gone, refuse_live_legacy_process,
    validate_write_destinations,
};
use crate::host::{ResolvedInstallation, ServiceConfiguration};

mod managed;
mod probe_auth;
mod readiness;
mod restart_handoff;
mod stop;
use readiness::{cleanup_spawned, wait_for_app_respawn, wait_until_ready, wait_until_registered};
pub(super) use restart_handoff::{execute_restart_handoff, spawn_restart_handoff};
use stop::{StopReport, stop_service_admitted};

const START_TIMEOUT: Duration = Duration::from_secs(90);
const INSTANCE_PUBLISH_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a restart of an App-supervised instance waits for the App to
/// start the replacement and for it to publish its record.
const APP_RESPAWN_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_TIMEOUT: Duration = Duration::from_secs(8);
const FORCE_STOP_TIMEOUT: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_millis(200);
/// [`active_service`] while an instance holds the DATA lock but has not
/// published its record yet: a starting instance, so waiters keep waiting.
const LOCK_WITHOUT_RECORD: &str = "native_service_instance_ambiguous: DATA lock has no record";
/// The line `butler stop` adds after a stop, worded like the App's quit dialog:
/// schedules run inside the service.
const SCHEDULES_STOPPED_NOTICE: &str =
    "Running work and schedules stop too until Butler starts again (butler start).";

/// How a lifecycle command runs.
#[derive(Clone, Copy)]
pub(super) struct ControlOptions {
    /// Report what would happen without doing it.
    pub(super) dry_run: bool,
    /// The controller recorded in the stop intent of `stop` and `restart`.
    pub(super) requested_by: StopRequester,
}

pub(super) async fn execute(
    action: Action,
    installation: ResolvedInstallation,
    requested_data: Option<&str>,
    control: ControlOptions,
) -> Result<Value, crate::host::HostError> {
    let ControlOptions {
        dry_run,
        requested_by,
    } = control;
    let data_root = resolve_data_root(requested_data, &installation)?;
    validate_write_destinations(&data_root, &installation)?;
    match action {
        Action::Start => {
            let config = service_configuration(&installation, &data_root)?;
            start_service(&installation, &config, dry_run).await
        }
        Action::Stop => {
            let request = StopRequest {
                reason: StopReason::Stop,
                requested_by,
            };
            stop_service(&data_root, &installation, dry_run, request).await
        }
        Action::Restart => {
            let config = service_configuration(&installation, &data_root)?;
            if dry_run {
                refuse_live_legacy_process(&data_root)?;
                let active = active_service(&data_root)?;
                return Ok(json!({
                    "service":"butler-agent-native",
                    "wouldRestart":true,
                    "currentlyRunning":active.is_some(),
                }));
            }
            let admission = acquire_admission(&data_root, &installation).await?;
            let request = StopRequest {
                reason: StopReason::Restart,
                requested_by,
            };
            let (stopped, admission) =
                stop_service_admitted(&data_root, &installation, admission, None, request).await?;
            start_replacement(&installation, &config, admission, &stopped).await
        }
        Action::Run => Err("service run is dispatched by the native service entrypoint".into()),
        Action::RestartHandoff => Err("restart handoff has a private entrypoint".into()),
        Action::RegisterLogin | Action::UnregisterLogin | Action::LoginStatus => {
            Err("login registration is dispatched by the registration command".into())
        }
    }
}

/// Whether an instance owns the data folder `requested_data` names (or the
/// default one). A folder that cannot be examined counts as not running:
/// starting will report the real problem.
pub(super) fn already_running(
    requested_data: Option<&str>,
    installation: &ResolvedInstallation,
) -> bool {
    resolve_data_root(requested_data, installation)
        .and_then(|data_root| active_service(&data_root))
        .is_ok_and(|active| active.is_some())
}

pub(super) fn summary(action: Action, value: &Value) -> String {
    match action {
        Action::Start if value["alreadyRunning"] == true => format!(
            "Butler native service is already running (pid={})",
            value["pid"].as_u64().unwrap_or_default()
        ),
        Action::Start if value["wouldStart"] == true => {
            "Butler native service start planned".into()
        }
        Action::Start => format!(
            "Butler native service started (pid={})",
            value["pid"].as_u64().unwrap_or_default()
        ),
        Action::Stop if value["alreadyStopped"] == true => {
            "Butler native service is not running".into()
        }
        Action::Stop if value["wouldStop"] == true => "Butler native service stop planned".into(),
        Action::Stop => format!("Butler native service stopped\n{SCHEDULES_STOPPED_NOTICE}"),
        Action::Restart => "Butler native service restarted".into(),
        Action::Run => "Butler native service run".into(),
        Action::RestartHandoff => "Butler native service restart handoff".into(),
        Action::RegisterLogin | Action::UnregisterLogin | Action::LoginStatus => String::new(),
    }
}

async fn start_service(
    installation: &ResolvedInstallation,
    config: &ServiceConfiguration,
    dry_run: bool,
) -> Result<Value, crate::host::HostError> {
    let data_root = &config.data_root;
    refuse_live_legacy_process(data_root)?;
    if dry_run {
        let active = active_service(data_root)?;
        return Ok(json!({
            "service":"butler-agent-native",
            "wouldStart":active.is_none(),
            "alreadyRunning":active.is_some(),
            "pid":active.map(|record| record.pid),
        }));
    }

    let admission = acquire_admission(data_root, installation).await?;
    start_service_admitted(installation, config, admission).await
}

async fn start_service_admitted(
    installation: &ResolvedInstallation,
    config: &ServiceConfiguration,
    admission: AdmissionLock,
) -> Result<Value, crate::host::HostError> {
    let data_root = &config.data_root;
    refuse_live_legacy_process(data_root)?;
    let active = active_service(data_root)?;
    if let Some(record) = active {
        drop(admission);
        let ready = wait_until_ready(config, None, Some(record.nonce.clone())).await?;
        return Ok(start_result(&ready, false));
    }
    if managed::job_loaded() {
        // The login job is loaded but idle: it, not this process, runs the
        // service, so it stays under the manager.
        managed::request(butler_platform::service_registration::start).await?;
        let registered = wait_for_app_respawn(data_root, "").await?;
        drop(admission);
        let ready = wait_until_ready(config, None, Some(registered.nonce)).await?;
        return Ok(start_result(&ready, true));
    }
    let mut spawned = spawn_service(installation, data_root)?;
    let registered = match wait_until_registered(data_root, &mut spawned).await {
        Ok(record) if record.pid == spawned.id() => record,
        Ok(_) => {
            cleanup_spawned(spawned).await;
            return Err("native_service_start_identity_changed".into());
        }
        Err(message) => {
            cleanup_spawned(spawned).await;
            return Err(message);
        }
    };
    drop(admission);
    let expected_pid = spawned.id();
    match wait_until_ready(config, Some(&mut spawned), Some(registered.nonce)).await {
        Ok(record) if record.pid == expected_pid => Ok(start_result(&record, true)),
        Ok(_) => {
            cleanup_spawned(spawned).await;
            Err("native_service_start_identity_changed".into())
        }
        Err(message) => {
            cleanup_spawned(spawned).await;
            Err(message)
        }
    }
}

fn start_result(record: &InstanceRecord, started: bool) -> Value {
    json!({
        "service":"butler-agent-native",
        "started":started,
        "alreadyRunning":!started,
        "ready":true,
        "pid":record.pid,
    })
}

/// Brings up the instance that replaces the one `stopped` describes. The App
/// starts the replacement of an instance it supervised, with its own
/// environment (gateway port, local auth, folder-selection secret, foreground
/// lease), and this controller only waits for it: an instance started here
/// would have this process's environment instead. Any other replacement is
/// started here.
async fn start_replacement(
    installation: &ResolvedInstallation,
    config: &ServiceConfiguration,
    admission: AdmissionLock,
    stopped: &StopReport,
) -> Result<Value, crate::host::HostError> {
    let StopReport::Stopped(instance) = stopped else {
        return start_service_admitted(installation, config, admission).await;
    };
    if !instance.app_supervised && !instance.managed {
        return start_service_admitted(installation, config, admission).await;
    }
    if instance.managed {
        managed::request(butler_platform::service_registration::start).await?;
    }
    // Admission stays held until the App's (or the login job's) instance is
    // registered, so no controller can start a CLI-environment instance in
    // its place.
    let registered = wait_for_app_respawn(&config.data_root, &instance.nonce).await?;
    drop(admission);
    let ready = wait_until_ready(config, None, Some(registered.nonce)).await?;
    Ok(start_result(&ready, true))
}

async fn stop_service(
    data_root: &Path,
    installation: &ResolvedInstallation,
    dry_run: bool,
    request: StopRequest,
) -> Result<Value, crate::host::HostError> {
    if dry_run {
        refuse_live_legacy_process(data_root)?;
        let active = active_service(data_root)?;
        let Some(record) = active else {
            return Ok(
                json!({"service":"butler-agent-native","stopped":true,"alreadyStopped":true}),
            );
        };
        return Ok(json!({
            "service":"butler-agent-native",
            "wouldStop":true,
            "pid":record.pid,
        }));
    }
    let admission = acquire_admission(data_root, installation).await?;
    let (report, _admission) =
        stop_service_admitted(data_root, installation, admission, None, request).await?;
    Ok(report.to_json())
}

pub(super) async fn acquire_admission(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<AdmissionLock, crate::host::HostError> {
    let end = Instant::now() + Duration::from_secs(3);
    loop {
        match AdmissionLock::acquire(data_root, installation) {
            Ok(lock) => return Ok(lock),
            Err(error)
                if error.message() == "service_start_admission_busy" && Instant::now() < end =>
            {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

pub(super) fn active_service(
    data_root: &Path,
) -> Result<Option<InstanceRecord>, crate::host::HostError> {
    let locked = instance_is_locked(data_root)?;
    let record = read_record(data_root)?;
    match (locked, record) {
        (false, None) => Ok(None),
        (false, Some(record)) => {
            if process_matches(&record)? {
                Err("native_service_instance_ambiguous: live record has no DATA lock".into())
            } else {
                Ok(None)
            }
        }
        (true, Some(record)) => {
            if matches!(record.state.as_str(), "starting" | "ready" | "stopping")
                && process_matches(&record)?
            {
                return Ok(Some(record));
            }
            if record_process_gone(&record)? {
                // Left by an instance that did not remove it (a crash, a
                // forced stop): the lock owner is a new instance that has
                // taken the lock and not yet replaced the record.
                return Err(LOCK_WITHOUT_RECORD.into());
            }
            Err("native_service_instance_ambiguous: lock owner does not match its record".into())
        }
        (true, None) => Err(LOCK_WITHOUT_RECORD.into()),
    }
}

fn spawn_service(
    installation: &ResolvedInstallation,
    data_root: &Path,
) -> Result<Child, crate::host::HostError> {
    validate_write_destinations(data_root, installation)?;
    let executable = std::env::current_exe()
        .map_err(|source| {
            crate::host::HostError::new("native_service_executable_unavailable").with_source(source)
        })?
        .canonicalize()
        .map_err(|source| {
            crate::host::HostError::new("native_service_executable_unavailable").with_source(source)
        })?;
    let logs = data_root.join("logs");
    secure_fs::create_private_dir_all(&logs).map_err(|source| {
        crate::host::HostError::new("native_service_logs_unavailable").with_source(source)
    })?;
    let stdout = log_file(&logs.join("butler-agent-service.stdout.log"), installation)?;
    let stderr = log_file(&logs.join("butler-agent-service.stderr.log"), installation)?;
    let mut command = Command::new(executable);
    command
        .arg("--installation-root")
        .arg(installation.root())
        .arg("--resource-root")
        .arg(installation.resources())
        .args(["service", "run", "--data"])
        .arg(data_root)
        .arg("--detached")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    process_control::detach(&mut command);
    command.spawn().map_err(|source| {
        crate::host::HostError::new("native_service_spawn_failed").with_source(source)
    })
}

fn log_file(
    path: &Path,
    installation: &ResolvedInstallation,
) -> Result<std::fs::File, crate::host::HostError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("native_service_logs_unavailable".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("native_service_logs_unavailable".into()),
    }
    installation.validate_data_root(path).map_err(|source| {
        crate::host::HostError::new("native_path_configuration_invalid").with_source(source)
    })?;
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    let _ = secure_fs::owner_only(&mut options);
    options.open(path).map_err(|source| {
        crate::host::HostError::new("native_service_logs_unavailable").with_source(source)
    })
}

pub(super) fn resolve_data_root(
    explicit: Option<&str>,
    installation: &ResolvedInstallation,
) -> Result<PathBuf, crate::host::HostError> {
    let home = user_home()?;
    let requested = explicit
        .map(PathBuf::from)
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

fn service_configuration(
    installation: &ResolvedInstallation,
    data_root: &Path,
) -> Result<ServiceConfiguration, crate::host::HostError> {
    let home = user_home()?;
    let data = data_root.to_string_lossy();
    ServiceConfiguration::capture(Some(&data), &home, installation).map_err(|error| {
        crate::host::HostError::new(format!("{}: {}", error.code(), error.message()))
            .with_source(error)
    })
}

fn user_home() -> Result<PathBuf, crate::host::HostError> {
    user_dirs::home_dir()
        .filter(|home| !home.as_os_str().is_empty())
        .ok_or_else(|| "native_home_unavailable".to_owned())
        .map_err(crate::host::HostError::from)
}

#[cfg(test)]
mod tests;
