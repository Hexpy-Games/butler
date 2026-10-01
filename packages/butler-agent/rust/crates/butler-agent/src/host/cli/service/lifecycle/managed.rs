//! A service instance a login job supervises (`butler startup enable`).
//!
//! The manager relaunches a job that dies from a signal, so a service it
//! runs is stopped by SIGTERM (a clean exit, which it does not relaunch),
//! never by a SIGKILL sent behind its back; what a polite stop cannot end is
//! stopped through the manager. Its replacement is started through the
//! manager too, so supervision survives a restart.
//!
//! A job is this DATA's only when its registered definition names this data
//! folder and runs a program from the Agent home; any other job of the label
//! (or none) leaves the CLI to start and stop the service itself. The manager
//! is per user, not per `HOME`: `BUTLER_SERVICE_MANAGER=off` switches every
//! request off (see `butler_platform::service_registration`).

use butler_platform::secure_fs::Canonical;
use std::path::Path;
use std::time::Duration;

use butler_platform::service_registration as manager;
use butler_runtime::operations::AgentHome;

use super::readiness::{wait_for_app_respawn, wait_until_ready};
use super::start_result;
use crate::host::ServiceConfiguration;
use crate::host::service::instance::{
    AdmissionLock, InstanceRecord, StopIntent, StopReason, StopRequest, StopRequester,
    withdraw_stop_intent, write_stop_intent,
};

/// Whether the registered login job is this DATA's: its definition runs a
/// program from the Agent home with `--data` naming `data_root`.
pub(super) fn job_is_ours(data_root: &Path) -> bool {
    if manager::manager_disabled() {
        return false;
    }
    let Ok(Some(registered)) = manager::registered() else {
        return false;
    };
    let resolved = |path: &Path| path.canonical().unwrap_or_else(|_| path.to_path_buf());
    registered
        .data
        .as_deref()
        .is_some_and(|data| resolved(data) == resolved(data_root))
        && AgentHome::resolve().is_ok_and(|home| home.contains(&registered.program))
}

/// Whether the manager runs `record`'s process as this DATA's job.
pub(super) fn is_managed(data_root: &Path, record: &InstanceRecord) -> bool {
    is_pid_managed(data_root, record.pid)
}

/// [`is_managed`] for a pid.
pub(super) fn is_pid_managed(data_root: &Path, pid: u32) -> bool {
    job_is_ours(data_root) && manager::job().is_ok_and(|job| job.loaded && job.pid == Some(pid))
}

/// Whether this DATA's job is registered but the manager cannot be asked, on
/// two tries a moment apart: the service might be running under it, and a
/// signal sent behind its back would look like a crash.
pub(super) async fn manager_unreachable(data_root: &Path) -> bool {
    let unreachable = || job_is_ours(data_root) && manager::job().is_ok_and(|job| !job.reachable);
    if !unreachable() {
        return false;
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    unreachable()
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

/// Restarts the instance the manager runs: the stop intent, then one request
/// to the manager, which stops and starts the job itself. No process the job
/// owns has to survive it (systemd stops everything in the unit with the old
/// process, and this may be run from a shell or helper inside it). Waits for
/// the replacement when the caller is still there to see it.
pub(super) async fn restart_instance(
    config: &ServiceConfiguration,
    active: &InstanceRecord,
    admission: AdmissionLock,
    requested_by: StopRequester,
) -> Result<serde_json::Value, crate::host::HostError> {
    let data_root = &config.data_root;
    let intent = StopIntent::new(
        StopRequest {
            reason: StopReason::Restart,
            requested_by,
        },
        active,
    );
    write_stop_intent(data_root, &intent).map_err(|source| {
        crate::host::HostError::new("native_service_stop_intent_unavailable").with_source(source)
    })?;
    let asked = match tokio::task::spawn_blocking(manager::restart_detached).await {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => request(manager::restart).await,
        Ok(Err(error)) => Err(format!("native_service_manager_failed: {error}").into()),
        Err(source) => Err(
            crate::host::HostError::new("native_service_manager_interrupted").with_source(source),
        ),
    };
    if let Err(error) = asked {
        let _ = withdraw_stop_intent(data_root, &active.nonce);
        return Err(error);
    }
    let registered = wait_for_app_respawn(data_root, &active.nonce).await?;
    drop(admission);
    let ready = wait_until_ready(config, None, Some(registered.nonce)).await?;
    Ok(start_result(&ready, true))
}
