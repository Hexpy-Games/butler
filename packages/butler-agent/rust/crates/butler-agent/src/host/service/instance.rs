//! DATA-scoped native service ownership, process identity, and legacy fencing.

use butler_platform::secure_fs::Canonical as _;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use butler_platform::instance::{InstanceLock, LockError};
use butler_platform::secure_fs;
use serde::{Deserialize, Serialize};

use crate::host::installation::ResolvedInstallation;
use crate::host::service::instance_identity::{
    executable_matches, process_executable, process_is_alive, process_start_identity,
};

const INSTANCE_SCHEMA: &str = "butler.native-agent-service-instance.v1";

mod delivery;
mod gateway_state;
mod probe;
mod record;
mod restart;
mod stop_intent;
mod stopping;
pub(crate) use delivery::{
    StopDelivery, force_stop, remove_shutdown_flag, request_stop, shutdown_flag_path,
};
pub(crate) use gateway_state::mark_gateway_state;
pub(crate) use probe::instance_lock_is_held_read_only;
use record::{
    acquire_record_update_lock, instance_record_path, read_record_at, record_update_lock_path,
    write_record,
};
pub(crate) use restart::RestartIdentity;
pub(crate) use stop_intent::{
    StopIntent, StopReason, StopRequest, StopRequester, clear_stop_intent, stop_announced_for,
    withdraw_stop_intent, write_stop_intent,
};
pub(crate) use stopping::{StoppingFrom, mark_stopping, revert_stopping};

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
    /// The Butler App supervises this instance through its foreground lease.
    /// On a restart the App, not the controller, starts the replacement, with
    /// the App's environment (gateway port, local auth, folder-selection
    /// secret, lease). Absent in records written before this field existed.
    #[serde(default)]
    pub(crate) app_supervised: bool,
}

/// This process's ownership of DATA: the exclusive instance lock, held until
/// the guard is dropped (the lock is unlocked explicitly then, and released
/// by the host if the process dies first), and the record it published.
pub(crate) struct InstanceGuard {
    _lock: InstanceLock,
    record_path: PathBuf,
    record_update_lock_path: PathBuf,
    installation: ResolvedInstallation,
    record: InstanceRecord,
}

/// The start admission lock: one controller at a time starts, stops or
/// restarts the instance of a DATA folder.
pub(crate) struct AdmissionLock {
    _lock: InstanceLock,
}

impl AdmissionLock {
    pub(crate) fn acquire(
        data_root: &Path,
        installation: &ResolvedInstallation,
    ) -> Result<Self, crate::host::HostError> {
        validate_write_destinations(data_root, installation)?;
        let path = admission_lock_path(data_root);
        let file = open_lock(&path, true)?;
        match InstanceLock::try_exclusive(file) {
            Ok(lock) => Ok(Self { _lock: lock }),
            Err(LockError::Busy) => Err("service_start_admission_busy".into()),
            Err(LockError::Failed(error)) => {
                Err(format!("service_start_admission_failed: {error}").into())
            }
        }
    }
}

impl InstanceGuard {
    /// Takes the DATA lock and publishes a `starting` record for this process;
    /// `app_supervised` says whether the App holds its foreground lease.
    pub(crate) fn acquire(
        data_root: &Path,
        executable: &Path,
        installation: &ResolvedInstallation,
        app_supervised: bool,
    ) -> Result<Self, crate::host::HostError> {
        validate_write_destinations(data_root, installation)?;
        // Where files have no owner-only mode (Windows), the DATA folder's
        // access list keeps its secrets from other users.
        if secure_fs::is_private(data_root) == Some(false) {
            let _ = secure_fs::protect_folder(data_root);
        }
        let lock_path = instance_lock_path(data_root);
        let file = open_lock(&lock_path, true)?;
        let lock = InstanceLock::try_exclusive(file).map_err(|error| match error {
            LockError::Busy => {
                "native_service_duplicate_writer: a service instance already owns this DATA".into()
            }
            LockError::Failed(error) => format!("native_service_lock_failed: {error}"),
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

        let executable = executable.canonical().map_err(|source| {
            crate::host::HostError::new("native_service_executable_unavailable").with_source(source)
        })?;
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
            app_supervised,
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
    ) -> Result<(), crate::host::HostError> {
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
        // A new instance reaching ready ends any earlier stop or restart intent.
        clear_stop_intent(data_root).map_err(|source| {
            crate::host::HostError::new("native_service_instance_state_unavailable")
                .with_source(source)
        })?;
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
    ) -> Result<(), crate::host::HostError> {
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

    /// Whether the App supervises this instance through its foreground lease.
    pub(crate) fn app_supervised(&self) -> bool {
        self.record.app_supervised
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

pub(crate) fn read_record(
    data_root: &Path,
) -> Result<Option<InstanceRecord>, crate::host::HostError> {
    read_record_at(&instance_record_path(data_root))
}

pub(crate) fn instance_is_locked(data_root: &Path) -> Result<bool, crate::host::HostError> {
    let path = instance_lock_path(data_root);
    let file = match open_lock(&path, false) {
        Ok(file) => file,
        Err(error) if error.message() == "service_lock_missing" => return Ok(false),
        Err(error) => return Err(error),
    };
    match InstanceLock::try_exclusive(file) {
        Ok(_) => Ok(false),
        Err(LockError::Busy) => Ok(true),
        Err(LockError::Failed(error)) => Err(format!("service_lock_probe_failed: {error}").into()),
    }
}

/// Whether the process `record` names has ended: no process has its PID, or
/// the one that has it started at another time (the PID was reused).
pub(crate) fn record_process_gone(record: &InstanceRecord) -> Result<bool, crate::host::HostError> {
    Ok(process_start_identity(record.pid)?.is_none_or(|start| start != record.process_start))
}

/// Returns true only when the current process still matches the persisted OS identity.
pub(crate) fn process_matches(record: &InstanceRecord) -> Result<bool, crate::host::HostError> {
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

pub(crate) fn validate_write_destinations(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<(), crate::host::HostError> {
    for destination in [data_root.join("state"), data_root.join("logs")] {
        installation
            .validate_data_root(&destination)
            .map_err(|source| {
                crate::host::HostError::new("native_path_configuration_invalid").with_source(source)
            })?;
    }
    Ok(())
}

pub(crate) fn refuse_live_legacy_process(data_root: &Path) -> Result<(), crate::host::HostError> {
    for path in [
        data_root.join("state/services/butler-main.json"),
        data_root.join("state/butler-main-native.json"),
    ] {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err("native_service_legacy_state_unreadable".into()),
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|source| {
            crate::host::HostError::new("native_service_legacy_state_ambiguous").with_source(source)
        })?;
        // Positive and within the host's signed process ids.
        let pid = value
            .get("pid")
            .and_then(serde_json::Value::as_u64)
            .filter(|pid| *pid > 0 && i32::try_from(*pid).is_ok())
            .and_then(|pid| u32::try_from(pid).ok())
            .ok_or_else(|| "native_service_legacy_state_ambiguous".to_owned())?;
        if process_is_alive(pid)? {
            return Err(format!(
                "native_service_legacy_supervisor_pid_alive: legacy state references live PID {pid}; verify and stop the existing Butler supervisor before starting the native service"
            ).into());
        }
    }
    Ok(())
}

fn open_lock(path: &Path, create: bool) -> Result<File, crate::host::HostError> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("service_lock_path_ambiguous".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "service_lock_path_invalid".to_owned())?;
    if create {
        secure_fs::create_private_dir_all(parent).map_err(|source| {
            crate::host::HostError::new("service_lock_directory_unavailable").with_source(source)
        })?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    let _ = secure_fs::owner_only(&mut options);
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
        .map_err(|source| {
            crate::host::HostError::new("service_lock_unavailable").with_source(source)
        })?
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
pub(crate) mod tests;
