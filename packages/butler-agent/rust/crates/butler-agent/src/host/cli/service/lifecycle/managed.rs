//! A service instance a login job supervises (`butler service install`).
//!
//! The manager relaunches a job that dies from a signal, so a service it
//! runs is stopped by SIGTERM (a clean exit, which it does not relaunch),
//! never by a SIGKILL sent behind its back; what a polite stop cannot end is
//! stopped through the manager. Its replacement is started through the
//! manager too, so supervision survives a restart.

use butler_platform::service_registration as manager;

use crate::host::service::instance::InstanceRecord;

/// Whether the manager runs `record`'s process as its job. A job that is not
/// loaded (nothing registered, a sandboxed `HOME`, no manager) runs nothing.
pub(super) fn is_managed(record: &InstanceRecord) -> bool {
    manager::job().is_ok_and(|job| job.loaded && job.pid == Some(record.pid))
}

/// Whether the manager has the job loaded, running or not.
pub(super) fn job_loaded() -> bool {
    manager::job().is_ok_and(|job| job.loaded)
}

/// A blocking manager request, off the async runtime.
pub(super) async fn request(
    call: fn() -> Result<(), manager::Error>,
) -> Result<(), crate::host::HostError> {
    tokio::task::spawn_blocking(call)
        .await
        .map_err(|source| {
            crate::host::HostError::new("native_service_manager_interrupted").with_source(source)
        })?
        .map_err(|error| format!("native_service_manager_failed: {error}").into())
}
