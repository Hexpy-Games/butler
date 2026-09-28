//! Delivering a controller's stop to the instance a record names, after the
//! caller has checked the record, the DATA lock and the process identity and
//! written the stop intent.
//!
//! On Unix the stop is SIGTERM and, after the grace period, SIGKILL. Windows
//! has no signal another process can send (see `butler_platform::instance`):
//! its stop becomes the control endpoint's `service_stop` command, or the
//! DATA shutdown flag for an instance that has not published its endpoint,
//! and the forced stop `TerminateProcess` on a handle whose start time was
//! compared. Until the Windows stage implements them, both report
//! `native_service_stop_unsupported`, so a stop is refused and withdrawn
//! like any stop that was not delivered.

use butler_platform::instance::{self as platform, StopError};

use super::InstanceRecord;
use crate::host::service::instance_identity::identity_error;

/// Asks the instance `record` names to stop (SIGTERM). An instance that has
/// already exited is `native_service_process_exited`.
pub(crate) fn request_stop(record: &InstanceRecord) -> Result<(), crate::host::HostError> {
    platform::request_stop(record.pid).map_err(stop_error)
}

/// Ends the instance `record` names at once (SIGKILL), only while its process
/// still started when the record says; otherwise it has exited
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
