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
    executable_matches, process_executable, process_start_identity,
};

const INSTANCE_SCHEMA: &str = "butler.native-agent-service-instance.v1";

mod delivery;
mod gateway_state;
mod legacy;
mod observe;
mod publication;
mod record;
#[cfg(feature = "e2e-fixtures")]
mod record_fault;
/// Shipped binaries order record writes by the record lock alone.
#[cfg(not(feature = "e2e-fixtures"))]
mod record_fault {
    pub(super) fn hold_write(_: &super::InstanceRecord) {}
    pub(super) fn lock_wait() {}
    pub(super) fn hold_rename() {}
    pub(super) fn cancel_rename() {}
    pub(super) fn write_finished() {}
    pub(super) fn hold(_: &str) {}
}
mod release;
mod restart;
mod stop_intent;
mod stopping;
pub(crate) use delivery::{
    StopDelivery, force_stop, remove_shutdown_flag, request_stop, shutdown_flag_path,
};
pub(crate) use gateway_state::mark_gateway_state;
pub(crate) use legacy::refuse_live_legacy_process;
pub(crate) use observe::{
    DATA_BUSY, Ownership, instance_is_locked, instance_is_locked_async, observe, observe_async,
};
pub(crate) use record::read_record_async;
use record::{
    acquire_record_update_lock, instance_record_path, read_record_at, record_update_lock_path,
    write_record,
};
pub(crate) use release::InstanceRelease;
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
    #[serde(default)]
    pub(crate) cli_supervisor_pid: Option<u32>,
    #[serde(default)]
    pub(crate) version: Option<String>,
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
/// the guard is released or dropped (the lock is unlocked explicitly then,
/// and released by the host if the process dies first), and the record it
/// published.
pub(crate) struct InstanceGuard {
    ownership: InstanceRelease,
    record_path: PathBuf,
    record_update_lock_path: PathBuf,
    installation: ResolvedInstallation,
    record: InstanceRecord,
    unclean_previous_exit: bool,
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

fn protect_data_root(data_root: &Path) -> Result<(), crate::host::HostError> {
    // Where files have no owner-only mode (Windows), the DATA folder's
    // access list keeps its secrets from other users.
    if secure_fs::OWNER_ONLY {
        if secure_fs::is_private(data_root) == Some(false) {
            let _ = secure_fs::protect_folder(data_root);
        }
    } else if secure_fs::is_private(data_root) != Some(true) {
        secure_fs::protect_folder(data_root)
            .transpose()
            .map_err(|source| {
                crate::host::HostError::new("native_service_data_privacy_failed")
                    .with_source(source)
            })?;
    }
    Ok(())
}

impl InstanceGuard {
    /// Takes the DATA lock and publishes a `starting` record for this process,
    /// in one hold of the record lock; `app_supervised` says whether the App
    /// holds its foreground lease.
    pub(crate) fn acquire(
        data_root: &Path,
        executable: &Path,
        installation: &ResolvedInstallation,
        app_supervised: bool,
    ) -> Result<Self, crate::host::HostError> {
        validate_write_destinations(data_root, installation)?;
        protect_data_root(data_root)?;
        let record_update_lock_path = record_update_lock_path(data_root);
        let record_update_lock = acquire_record_update_lock(&record_update_lock_path)?;
        let file = open_lock(&instance_lock_path(data_root), true)?;
        let lock = InstanceLock::try_exclusive(file).map_err(|error| match error {
            LockError::Busy => {
                "native_service_duplicate_writer: a service instance already owns this DATA".into()
            }
            LockError::Failed(error) => format!("native_service_lock_failed: {error}"),
        })?;

        refuse_live_legacy_process(data_root)?;
        let record_path = instance_record_path(data_root);
        let previous = read_record_at(&record_path)?;
        if let Some(previous) = &previous
            && process_matches(previous)?
        {
            return Err(
                "native_service_instance_ambiguous: a recorded service process is alive without the DATA lock".into(),
            );
        }
        let unclean_previous_exit = report_previous_exit(data_root, previous.as_ref());
        let record = starting_record(executable, installation, app_supervised)?;
        record_fault::hold("startup");
        write_record(&record_path, &record)?;
        drop(record_update_lock);
        Ok(Self {
            ownership: InstanceRelease::new(
                record_path.clone(),
                installation.clone(),
                record.nonce.clone(),
                lock,
            ),
            record_path,
            record_update_lock_path,
            installation: installation.clone(),
            record,
            unclean_previous_exit,
        })
    }

    /// The release the shutdown deadline runs before a forced exit.
    pub(crate) fn deadline_release(&self) -> InstanceRelease {
        self.ownership.clone()
    }

    pub(crate) fn nonce(&self) -> &str {
        &self.record.nonce
    }

    pub(crate) fn unclean_previous_exit(&self) -> bool {
        self.unclean_previous_exit
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

impl InstanceGuard {
    /// Explicit shutdown already runs on a blocking thread and waits for release.
    pub(crate) fn release(self) {
        if self.ownership.holds_data() {
            self.ownership.release();
        }
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        if !self.ownership.holds_data() {
            return;
        }
        let ownership = self.ownership.clone();
        let release = move || ownership.release();
        // Finish before cancellation returns or the runtime shuts down. A
        // multi-thread worker hands its other tasks off while release blocks.
        // block_in_place is unsupported on current-thread runtimes.
        if tokio::runtime::Handle::try_current().is_ok_and(|runtime| {
            runtime.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread
        }) {
            tokio::task::block_in_place(release);
        } else {
            release();
        }
    }
}

pub(crate) fn read_record(
    data_root: &Path,
) -> Result<Option<InstanceRecord>, crate::host::HostError> {
    read_record_at(&instance_record_path(data_root))
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

/// Holds DATA ownership for a stopped-service write without a record; takes
/// it inside a hold of the record lock, as every DATA owner does.
pub(crate) fn lock_stopped_data(data_root: &Path) -> Result<InstanceLock, crate::host::HostError> {
    let _record_update_lock = acquire_record_update_lock(&record_update_lock_path(data_root))?;
    let file = open_lock(&instance_lock_path(data_root), true)?;
    InstanceLock::try_exclusive(file).map_err(|_| crate::host::HostError::new("service_data_busy"))
}

fn open_lock(path: &Path, create: bool) -> Result<File, crate::host::HostError> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("service_lock_path_ambiguous".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "service_lock_path_invalid".to_owned())?;
    if create {
        super::data_ownership::initialize_for_lock(parent)?;
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
    data_root.join(crate::host::service::paths::INSTANCE_LOCK)
}

fn admission_lock_path(data_root: &Path) -> PathBuf {
    data_root.join(crate::host::service::paths::ADMISSION_LOCK)
}

#[cfg(test)]
pub(crate) mod tests;

fn starting_record(
    executable: &Path,
    installation: &ResolvedInstallation,
    app_supervised: bool,
) -> Result<InstanceRecord, crate::host::HostError> {
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
    Ok(InstanceRecord {
        schema: INSTANCE_SCHEMA.into(),
        nonce: super::instance_identity::instance_nonce(),
        pid,
        cli_supervisor_pid: std::env::var("BUTLER_CLI_SUPERVISOR_PID")
            .ok()
            .and_then(|pid| pid.parse().ok()),
        version: Some(super::diagnostics::version(installation)),
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
    })
}

fn report_previous_exit(data_root: &Path, previous: Option<&InstanceRecord>) -> bool {
    let unclean_previous_exit = previous
        .is_some_and(|previous| !stop_announced_for(data_root, previous.pid, &previous.nonce));
    if unclean_previous_exit
        && let Some(previous) = previous
        && previous.cli_supervisor_pid.is_none()
    {
        super::diagnostics::previous_exit(previous);
    }

    unclean_previous_exit
}
