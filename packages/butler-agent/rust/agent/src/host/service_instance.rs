//! DATA-scoped native service ownership, process identity, and legacy fencing.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use nix::errno::Errno;
use nix::fcntl::{Flock, FlockArg};
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};

use super::installation::ResolvedInstallation;
use super::service_instance_identity::{
    executable_matches, process_executable, process_is_alive, process_start_identity,
};

const INSTANCE_SCHEMA: &str = "butler.native-agent-service-instance.v1";

mod gateway_state;
mod probe;
mod record;
mod restart;
pub(crate) use gateway_state::mark_gateway_state;
pub(crate) use probe::instance_lock_is_held_read_only;
use record::{
    acquire_record_update_lock, instance_record_path, read_record_at, record_update_lock_path,
    write_record,
};
pub(crate) use restart::RestartIdentity;

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct InstanceRecord {
    schema: String,
    pub(crate) nonce: String,
    pub(crate) pid: u32,
    pub(crate) process_start: String,
    pub(crate) executable: String,
    pub(crate) state: String,
    pub(crate) app_enabled: bool,
    pub(crate) app_endpoint: Option<String>,
    pub(crate) app_auth_required: bool,
    pub(crate) ready_at: Option<String>,
    #[serde(default)]
    pub(crate) control_endpoint: Option<String>,
    #[serde(default)]
    pub(crate) control_token: Option<String>,
}

pub(crate) struct InstanceGuard {
    _lock: Flock<File>,
    record_path: PathBuf,
    record_update_lock_path: PathBuf,
    installation: ResolvedInstallation,
    record: InstanceRecord,
}

pub(crate) struct AdmissionLock {
    _lock: Flock<File>,
}

impl AdmissionLock {
    pub(crate) fn acquire(
        data_root: &Path,
        installation: &ResolvedInstallation,
    ) -> Result<Self, String> {
        validate_write_destinations(data_root, installation)?;
        let path = admission_lock_path(data_root);
        let file = open_lock(&path, true)?;
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => Ok(Self { _lock: lock }),
            Err((_, Errno::EAGAIN)) => Err("service_start_admission_busy".into()),
            Err((_, error)) => Err(format!("service_start_admission_failed: {error}")),
        }
    }
}

impl InstanceGuard {
    pub(crate) fn acquire(
        data_root: &Path,
        executable: &Path,
        installation: &ResolvedInstallation,
    ) -> Result<Self, String> {
        validate_write_destinations(data_root, installation)?;
        let lock_path = instance_lock_path(data_root);
        let file = open_lock(&lock_path, true)?;
        let lock = Flock::lock(file, FlockArg::LockExclusiveNonblock).map_err(|(_, error)| {
            if error == Errno::EAGAIN {
                "native_service_duplicate_writer: a service instance already owns this DATA".into()
            } else {
                format!("native_service_lock_failed: {error}")
            }
        })?;

        refuse_live_legacy_process(data_root)?;
        let record_path = instance_record_path(data_root);
        if let Some(previous) = read_record_at(&record_path)?
            && process_matches(&previous)?
        {
            return Err(
                "native_service_instance_ambiguous: a recorded service process is alive without the DATA lock".into(),
            );
        }

        let executable = executable
            .canonicalize()
            .map_err(|_| "native_service_executable_unavailable".to_owned())?;
        let pid = std::process::id();
        let process_start = process_start_identity(pid)?
            .ok_or_else(|| "native_service_process_identity_unavailable".to_owned())?;
        let observed_executable = process_executable(pid)?
            .ok_or_else(|| "native_service_process_identity_unavailable".to_owned())?;
        if !executable_matches(&executable.to_string_lossy(), &observed_executable) {
            return Err("native_service_executable_identity_mismatch".into());
        }
        let record = InstanceRecord {
            schema: INSTANCE_SCHEMA.into(),
            nonce: uuid::Uuid::new_v4().to_string(),
            pid,
            process_start,
            executable: executable.to_string_lossy().into_owned(),
            state: "starting".into(),
            app_enabled: false,
            app_endpoint: None,
            app_auth_required: false,
            ready_at: None,
            control_endpoint: None,
            control_token: None,
        };
        let record_update_lock_path = record_update_lock_path(data_root);
        let _record_update_lock = acquire_record_update_lock(&record_update_lock_path)?;
        write_record(&record_path, &record)?;
        Ok(Self {
            _lock: lock,
            record_path,
            record_update_lock_path,
            installation: installation.clone(),
            record,
        })
    }

    pub(crate) fn mark_ready(
        &mut self,
        app_enabled: bool,
        app_endpoint: Option<String>,
        app_auth_required: bool,
        ready_at: String,
    ) -> Result<(), String> {
        let data_root = self
            .record_path
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| "native_service_instance_record_path_invalid".to_owned())?;
        validate_write_destinations(data_root, &self.installation)?;
        let _record_update_lock = acquire_record_update_lock(&self.record_update_lock_path)?;
        let mut current = read_record_at(&self.record_path)?.ok_or_else(|| {
            "native_service_instance_ambiguous: instance record is missing".to_owned()
        })?;
        if current.nonce != self.record.nonce {
            return Err("native_service_instance_changed".into());
        }
        if current.state == "stopping" {
            return Err("native_service_start_cancelled".into());
        }
        if current.state != "starting" {
            return Err("native_service_instance_ambiguous: invalid startup transition".into());
        }
        current.state = "ready".into();
        current.app_enabled = app_enabled;
        current.app_endpoint = app_endpoint;
        current.app_auth_required = app_auth_required;
        current.ready_at = Some(ready_at);
        write_record(&self.record_path, &current)?;
        self.record = current;
        Ok(())
    }

    pub(crate) fn publish_control(
        &mut self,
        endpoint: String,
        token: String,
    ) -> Result<(), String> {
        let data_root = self
            .record_path
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| "native_service_instance_record_path_invalid".to_owned())?;
        validate_write_destinations(data_root, &self.installation)?;
        let _record_update_lock = acquire_record_update_lock(&self.record_update_lock_path)?;
        let mut current = read_record_at(&self.record_path)?.ok_or_else(|| {
            "native_service_instance_ambiguous: instance record is missing".to_owned()
        })?;
        if current.nonce != self.record.nonce {
            return Err("native_service_instance_changed".into());
        }
        current.control_endpoint = Some(endpoint);
        current.control_token = Some(token);
        write_record(&self.record_path, &current)?;
        self.record = current;
        Ok(())
    }

    pub(crate) fn nonce(&self) -> &str {
        &self.record.nonce
    }

    pub(crate) fn restart_identity(&self) -> RestartIdentity {
        RestartIdentity {
            pid: self.record.pid,
            process_start: self.record.process_start.clone(),
            nonce: self.record.nonce.clone(),
            executable: self.record.executable.clone(),
        }
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        let Some(data_root) = self.record_path.parent().and_then(Path::parent) else {
            return;
        };
        if validate_write_destinations(data_root, &self.installation).is_err() {
            return;
        }
        let Ok(_record_update_lock) = acquire_record_update_lock(&self.record_update_lock_path)
        else {
            return;
        };
        if read_record_at(&self.record_path)
            .ok()
            .flatten()
            .is_some_and(|current| current.nonce == self.record.nonce)
        {
            let _ = fs::remove_file(&self.record_path);
        }
    }
}

pub(crate) fn read_record(data_root: &Path) -> Result<Option<InstanceRecord>, String> {
    read_record_at(&instance_record_path(data_root))
}

pub(crate) fn instance_is_locked(data_root: &Path) -> Result<bool, String> {
    let path = instance_lock_path(data_root);
    let file = match open_lock(&path, false) {
        Ok(file) => file,
        Err(error) if error == "service_lock_missing" => return Ok(false),
        Err(error) => return Err(error),
    };
    match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
        Ok(_) => Ok(false),
        Err((_, Errno::EAGAIN)) => Ok(true),
        Err((_, error)) => Err(format!("service_lock_probe_failed: {error}")),
    }
}

/// Returns true only when the current process still matches the persisted OS identity.
pub(crate) fn process_matches(record: &InstanceRecord) -> Result<bool, String> {
    if record.schema != INSTANCE_SCHEMA || record.pid == 0 || record.executable.is_empty() {
        return Err("native_service_instance_ambiguous: invalid instance record".into());
    }
    let Some(start) = process_start_identity(record.pid)? else {
        return Ok(false);
    };
    let Some(executable) = process_executable(record.pid)? else {
        return Ok(false);
    };
    Ok(start == record.process_start && executable_matches(&record.executable, &executable))
}

pub(crate) fn mark_stopping(
    data_root: &Path,
    nonce: &str,
    installation: &ResolvedInstallation,
) -> Result<(), String> {
    validate_write_destinations(data_root, installation)?;
    let path = instance_record_path(data_root);
    let _record_update_lock = acquire_record_update_lock(&record_update_lock_path(data_root))?;
    let mut record = read_record_at(&path)?.ok_or_else(|| {
        "native_service_instance_ambiguous: instance record is missing".to_owned()
    })?;
    if record.nonce != nonce {
        return Err("native_service_instance_changed".into());
    }
    if record.state == "stopping" {
        return Ok(());
    }
    if !matches!(record.state.as_str(), "starting" | "ready") {
        return Err("native_service_instance_ambiguous: invalid stop transition".into());
    }
    record.state = "stopping".into();
    write_record(&path, &record)
}

pub(crate) fn validate_write_destinations(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<(), String> {
    for destination in [data_root.join("state"), data_root.join("logs")] {
        installation
            .validate_data_root(&destination)
            .map_err(|_| "native_path_configuration_invalid".to_owned())?;
    }
    Ok(())
}

pub(crate) fn send_signal(record: &InstanceRecord, signal: Signal) -> Result<(), String> {
    let pid = i32::try_from(record.pid)
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| "native_service_instance_ambiguous: invalid process id".to_owned())?;
    kill(Pid::from_raw(pid), signal).map_err(|error| {
        if error == Errno::ESRCH {
            "native_service_process_exited".into()
        } else {
            format!("native_service_signal_failed: {error}")
        }
    })
}

pub(crate) fn refuse_live_legacy_process(data_root: &Path) -> Result<(), String> {
    for path in [
        data_root.join("state/services/butler-main.json"),
        data_root.join("state/butler-main-native.json"),
    ] {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err("native_service_legacy_state_unreadable".into()),
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| "native_service_legacy_state_ambiguous".to_owned())?;
        let pid = value
            .get("pid")
            .and_then(serde_json::Value::as_u64)
            .filter(|pid| *pid > 0)
            .and_then(|pid| i32::try_from(pid).ok())
            .ok_or_else(|| "native_service_legacy_state_ambiguous".to_owned())?;
        if process_is_alive(pid)? {
            return Err(format!(
                "native_service_legacy_supervisor_pid_alive: legacy state references live PID {pid}; verify and stop the existing Butler supervisor before starting the native service"
            ));
        }
    }
    Ok(())
}

fn open_lock(path: &Path, create: bool) -> Result<File, String> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("service_lock_path_ambiguous".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "service_lock_path_invalid".to_owned())?;
    if create {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .map_err(|_| "service_lock_directory_unavailable".to_owned())?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).mode(0o600);
    if create {
        options.create(true);
    }
    let file = options.open(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            String::from("service_lock_missing")
        } else {
            String::from("service_lock_unavailable")
        }
    })?;
    if !file
        .metadata()
        .map_err(|_| "service_lock_unavailable".to_owned())?
        .is_file()
    {
        return Err("service_lock_path_ambiguous".into());
    }
    Ok(file)
}

fn instance_lock_path(data_root: &Path) -> PathBuf {
    data_root.join("state/butler-agent-native-service.lock")
}

fn admission_lock_path(data_root: &Path) -> PathBuf {
    data_root.join("state/butler-agent-native-service-start.lock")
}

#[cfg(test)]
mod tests;
