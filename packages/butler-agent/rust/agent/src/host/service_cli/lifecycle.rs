//! Detached launch, identity-checked stop, and readiness for the native service.

use std::fs::{self, OpenOptions};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::sys::signal::Signal;
use serde_json::{Value, json};

use super::super::service_instance::{
    AdmissionLock, InstanceRecord, RestartIdentity, instance_is_locked, mark_stopping,
    process_matches, read_record, refuse_live_legacy_process, send_signal,
    validate_write_destinations,
};
use super::super::{NativeServiceConfiguration, ResolvedInstallation};
use super::Action;

mod readiness;
mod restart_handoff;
use readiness::{cleanup_spawned, wait_for_stop, wait_until_ready, wait_until_registered};
pub(super) use restart_handoff::{execute_restart_handoff, spawn_restart_handoff};

const START_TIMEOUT: Duration = Duration::from_secs(90);
const INSTANCE_PUBLISH_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_TIMEOUT: Duration = Duration::from_secs(8);
const FORCE_STOP_TIMEOUT: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

pub(super) async fn execute(
    action: Action,
    installation: ResolvedInstallation,
    requested_data: Option<&str>,
    dry_run: bool,
) -> Result<Value, String> {
    let data_root = resolve_data_root(requested_data, &installation)?;
    validate_write_destinations(&data_root, &installation)?;
    match action {
        Action::Start => {
            let config = service_configuration(&installation, &data_root)?;
            start_service(&installation, &config, dry_run).await
        }
        Action::Stop => stop_service(&data_root, &installation, dry_run).await,
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
            let (_, admission) =
                stop_service_admitted(&data_root, &installation, admission, None).await?;
            start_service_admitted(&installation, &config, admission).await
        }
        Action::Run => Err("service run is dispatched by the native service entrypoint".into()),
        Action::RestartHandoff => Err("restart handoff has a private entrypoint".into()),
    }
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
        Action::Stop => "Butler native service stopped".into(),
        Action::Restart => "Butler native service restarted".into(),
        Action::Run => "Butler native service run".into(),
        Action::RestartHandoff => "Butler native service restart handoff".into(),
    }
}

async fn start_service(
    installation: &ResolvedInstallation,
    config: &NativeServiceConfiguration,
    dry_run: bool,
) -> Result<Value, String> {
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
    config: &NativeServiceConfiguration,
    admission: AdmissionLock,
) -> Result<Value, String> {
    let data_root = &config.data_root;
    refuse_live_legacy_process(data_root)?;
    let active = active_service(data_root)?;
    if let Some(record) = active {
        drop(admission);
        let ready = wait_until_ready(config, None, Some(record.nonce.clone())).await?;
        return Ok(start_result(&ready, false));
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

async fn stop_service(
    data_root: &Path,
    installation: &ResolvedInstallation,
    dry_run: bool,
) -> Result<Value, String> {
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
    let (result, _admission) =
        stop_service_admitted(data_root, installation, admission, None).await?;
    Ok(result)
}

async fn stop_service_admitted(
    data_root: &Path,
    installation: &ResolvedInstallation,
    admission: AdmissionLock,
    expected: Option<&RestartIdentity>,
) -> Result<(Value, AdmissionLock), String> {
    refuse_live_legacy_process(data_root)?;
    let Some(record) = active_service(data_root)? else {
        return Ok((
            json!({"service":"butler-agent-native","stopped":true,"alreadyStopped":true}),
            admission,
        ));
    };
    if expected.is_some_and(|identity| !identity.matches(&record)) {
        return Err("native_service_instance_changed".into());
    }
    mark_stopping(data_root, &record.nonce, installation)?;
    let current =
        active_service(data_root)?.ok_or_else(|| "native_service_instance_changed".to_owned())?;
    if current.nonce != record.nonce
        || current.pid != record.pid
        || expected.is_some_and(|identity| !identity.matches(&current))
    {
        return Err("native_service_instance_changed".into());
    }
    if !instance_is_locked(data_root)? || !process_matches(&current)? {
        return Err("native_service_instance_ambiguous: refusing signal".into());
    }
    if let Err(error) = send_signal(&current, Signal::SIGTERM)
        && error != "native_service_process_exited"
    {
        return Err(error);
    }
    if wait_for_stop(data_root, &record.nonce, STOP_TIMEOUT).await? {
        return Ok((
            json!({"service":"butler-agent-native","stopped":true,"pid":record.pid}),
            admission,
        ));
    }
    let current =
        active_service(data_root)?.ok_or_else(|| "native_service_instance_changed".to_owned())?;
    if current.nonce != record.nonce
        || current.pid != record.pid
        || expected.is_some_and(|identity| !identity.matches(&current))
    {
        return Ok((
            json!({"service":"butler-agent-native","stopped":true,"pid":record.pid}),
            admission,
        ));
    }
    // Re-read the lock, nonce, PID, OS start identity, and executable directly
    // before force-killing the recorded service process.
    if !instance_is_locked(data_root)? || !process_matches(&current)? {
        return Err("native_service_instance_ambiguous: refusing force kill".into());
    }
    send_signal(&current, Signal::SIGKILL)?;
    if !wait_for_stop(data_root, &record.nonce, FORCE_STOP_TIMEOUT).await? {
        return Err("native_service_stop_timeout".into());
    }
    Ok((
        json!({"service":"butler-agent-native","stopped":true,"forced":true,"pid":record.pid}),
        admission,
    ))
}

async fn acquire_admission(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<AdmissionLock, String> {
    let end = Instant::now() + Duration::from_secs(3);
    loop {
        match AdmissionLock::acquire(data_root, installation) {
            Ok(lock) => return Ok(lock),
            Err(error) if error == "service_start_admission_busy" && Instant::now() < end => {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

fn active_service(data_root: &Path) -> Result<Option<InstanceRecord>, String> {
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
            if !matches!(record.state.as_str(), "starting" | "ready" | "stopping")
                || !process_matches(&record)?
            {
                return Err(
                    "native_service_instance_ambiguous: lock owner does not match its record"
                        .into(),
                );
            }
            Ok(Some(record))
        }
        (true, None) => Err("native_service_instance_ambiguous: DATA lock has no record".into()),
    }
}

fn spawn_service(installation: &ResolvedInstallation, data_root: &Path) -> Result<Child, String> {
    validate_write_destinations(data_root, installation)?;
    let executable = std::env::current_exe()
        .map_err(|_| "native_service_executable_unavailable".to_owned())?
        .canonicalize()
        .map_err(|_| "native_service_executable_unavailable".to_owned())?;
    let logs = data_root.join("logs");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&logs)
        .map_err(|_| "native_service_logs_unavailable".to_owned())?;
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
        .stderr(Stdio::from(stderr))
        .process_group(0);
    command
        .spawn()
        .map_err(|_| "native_service_spawn_failed".to_owned())
}

fn log_file(path: &Path, installation: &ResolvedInstallation) -> Result<std::fs::File, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("native_service_logs_unavailable".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("native_service_logs_unavailable".into()),
    }
    installation
        .validate_data_root(path)
        .map_err(|_| "native_path_configuration_invalid".to_owned())?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| "native_service_logs_unavailable".to_owned())
}

fn resolve_data_root(
    explicit: Option<&str>,
    installation: &ResolvedInstallation,
) -> Result<PathBuf, String> {
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
        .map_err(|_| "native_path_configuration_invalid".to_owned())
}

fn service_configuration(
    installation: &ResolvedInstallation,
    data_root: &Path,
) -> Result<NativeServiceConfiguration, String> {
    let home = user_home()?;
    let data = data_root.to_string_lossy();
    NativeServiceConfiguration::capture(Some(&data), &home, installation)
        .map_err(|error| format!("{}: {}", error.code(), error.message()))
}

fn user_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "native_home_unavailable".to_owned())
}

#[cfg(test)]
mod tests;
