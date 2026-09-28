//! Delivering a controller's stop to the instance a record names, after the
//! caller has checked the record, the DATA lock and the process identity and
//! written the stop intent.
//!
//! On Unix the stop is SIGTERM and, after the grace period, SIGKILL. Windows
//! has no signal another process can send (see `butler_platform::instance`):
//! its stop is the control endpoint's `service_stop` command, or, for an
//! instance that has not published its endpoint yet, the DATA shutdown flag
//! (`locks/butler-shutdown`), which the controller removes again once the
//! instance is gone. The forced stop ends the process through a handle whose
//! start time was compared (see `butler_platform::instance::terminate`).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use butler_platform::instance::{self as platform, StopError};

use super::InstanceRecord;
use crate::host::service::instance_identity::identity_error;

/// How a stop reached the instance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StopDelivery {
    /// SIGTERM (Unix).
    Signal,
    /// The control endpoint's `service_stop` command.
    Control,
    /// The DATA shutdown flag, for an instance without a control endpoint
    /// yet; the controller removes it once the instance is gone.
    ShutdownFlag,
}

/// The DATA shutdown flag: a service that finds it stops as if asked to.
pub(crate) fn shutdown_flag_path(data_root: &Path) -> PathBuf {
    data_root.join("locks/butler-shutdown")
}

/// Asks the instance `record` names to stop: SIGTERM, or where the host has
/// no stop signal, `service_stop` through its control endpoint (the DATA
/// shutdown flag while it has none). An instance that has already exited is
/// `native_service_process_exited`.
pub(crate) async fn request_stop(
    data_root: &Path,
    record: &InstanceRecord,
) -> Result<StopDelivery, crate::host::HostError> {
    match platform::request_stop(record.pid) {
        Ok(()) => return Ok(StopDelivery::Signal),
        Err(StopError::Unsupported) => {}
        Err(error) => return Err(stop_error(error)),
    }
    if record.control_endpoint.is_none() {
        write_shutdown_flag(data_root)?;
        return Ok(StopDelivery::ShutdownFlag);
    }
    match crate::host::app::gateway_lifecycle::request_service_stop(record).await {
        Ok(()) => Ok(StopDelivery::Control),
        // The endpoint closed because the instance exited meanwhile.
        Err(_) if !super::process_matches(record).unwrap_or(true) => {
            Err("native_service_process_exited".into())
        }
        Err(error) => Err(error),
    }
}

fn write_shutdown_flag(data_root: &Path) -> Result<(), crate::host::HostError> {
    let path = shutdown_flag_path(data_root);
    let written = path
        .parent()
        .map_or(Ok(()), butler_platform::secure_fs::create_private_dir_all)
        .and_then(|()| fs::write(&path, b"stop\n"));
    written.map_err(|source| {
        crate::host::HostError::new("native_service_shutdown_flag_unavailable").with_source(source)
    })
}

/// Removes the shutdown flag a [`StopDelivery::ShutdownFlag`] stop wrote, so
/// the next instance starts; a missing flag is already removed.
pub(crate) fn remove_shutdown_flag(data_root: &Path) -> io::Result<()> {
    match fs::remove_file(shutdown_flag_path(data_root)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Ends the instance `record` names at once (SIGKILL; on Windows `taskkill /F`
/// while a handle to the process is held), only while its process still
/// started when the record says; otherwise it has exited
/// (`native_service_process_exited`).
pub(crate) fn force_stop(record: &InstanceRecord) -> Result<(), crate::host::HostError> {
    platform::terminate(record.pid, &record.process_start).map_err(stop_error)
}

fn stop_error(error: StopError) -> crate::host::HostError {
    let message = match error {
        StopError::InvalidPid(_) => "native_service_instance_ambiguous: invalid process id".into(),
        StopError::Gone => "native_service_process_exited".into(),
        StopError::Identity(error) => {
            return identity_error(error, "native_service_process_identity_unavailable");
        }
        StopError::Delivery(detail) => format!("native_service_signal_failed: {detail}"),
        StopError::Unsupported => "native_service_stop_unsupported".into(),
    };
    crate::host::HostError::new(message)
}
