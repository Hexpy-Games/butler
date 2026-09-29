//! Identity-checked, announced stop of the native service.

use std::path::Path;

use serde_json::{Value, json};

use super::managed::{is_managed, manager_unreachable, request};
use super::readiness::wait_for_stop;
use super::{FORCE_STOP_TIMEOUT, STOP_TIMEOUT, active_service};
use crate::host::ResolvedInstallation;
use crate::host::service::instance::{
    AdmissionLock, InstanceRecord, RestartIdentity, StopIntent, StopRequest, StoppingFrom,
    force_stop, instance_is_locked, mark_stopping, process_matches, refuse_live_legacy_process,
    request_stop, revert_stopping, withdraw_stop_intent, write_stop_intent,
};

/// What a controlled stop found and did.
pub(super) enum StopReport {
    /// No instance owned DATA.
    AlreadyStopped,
    /// The instance exited.
    Stopped(StoppedInstance),
}

/// The instance a stop ended.
pub(super) struct StoppedInstance {
    /// Its PID.
    pub(super) pid: u32,
    /// Its record nonce.
    pub(super) nonce: String,
    /// It had to be killed after the SIGTERM grace period.
    pub(super) forced: bool,
    /// The App supervised it, so the App starts its replacement on restart.
    pub(super) app_supervised: bool,
    /// A login job (launchd, systemd) ran it, so the manager starts its
    /// replacement on restart.
    pub(super) managed: bool,
}

impl StopReport {
    /// The command result `butler stop --json` prints.
    pub(super) fn to_json(&self) -> Value {
        match self {
            Self::AlreadyStopped => {
                json!({"service":"butler-agent-native","stopped":true,"alreadyStopped":true})
            }
            Self::Stopped(instance) if instance.forced => json!({
                "service":"butler-agent-native","stopped":true,"forced":true,"pid":instance.pid,
            }),
            Self::Stopped(instance) => {
                json!({"service":"butler-agent-native","stopped":true,"pid":instance.pid})
            }
        }
    }
}

/// A stop that never reached the instance and whose record could not leave
/// `stopping` again.
#[derive(Debug, thiserror::Error)]
#[error("{revert}")]
struct UndeliveredStopRevertFailed {
    /// Why the record kept `stopping`.
    revert: crate::host::HostError,
    /// Why the stop was not delivered.
    #[source]
    stop: crate::host::HostError,
}

/// Stops the instance that owns DATA while the caller holds admission:
/// marks its record `stopping`, re-verifies its identity, announces the stop
/// in the intent file, sends SIGTERM and waits, force-killing after
/// [`STOP_TIMEOUT`]. A stop that is never delivered leaves the record as it was.
pub(super) async fn stop_service_admitted(
    data_root: &Path,
    installation: &ResolvedInstallation,
    admission: AdmissionLock,
    expected: Option<&RestartIdentity>,
    request: StopRequest,
) -> Result<(StopReport, AdmissionLock), crate::host::HostError> {
    refuse_live_legacy_process(data_root)?;
    let Some(record) = active_service(data_root)? else {
        return Ok((StopReport::AlreadyStopped, admission));
    };
    if expected.is_some_and(|identity| !identity.matches(&record)) {
        return Err("native_service_instance_changed".into());
    }
    let managed = is_managed(data_root, &record);
    let previous = mark_stopping(data_root, &record.nonce, installation)?;
    if let Err(error) = deliver_stop(data_root, &record, expected, request) {
        return Err(revert_undelivered_stop(
            data_root,
            installation,
            &record,
            previous,
            error,
        ));
    }
    let forced = wait_or_force_stop(data_root, &record, expected).await?;
    let stopped = StoppedInstance {
        pid: record.pid,
        nonce: record.nonce,
        forced,
        app_supervised: record.app_supervised,
        managed,
    };
    Ok((StopReport::Stopped(stopped), admission))
}

fn same_instance(
    current: &InstanceRecord,
    record: &InstanceRecord,
    expected: Option<&RestartIdentity>,
) -> bool {
    current.nonce == record.nonce
        && current.pid == record.pid
        && expected.is_none_or(|identity| identity.matches(current))
}

/// Re-verifies the instance [`mark_stopping`] marked (its record, the DATA
/// lock and its OS identity) and signals it. An error means nothing was
/// delivered.
fn deliver_stop(
    data_root: &Path,
    record: &InstanceRecord,
    expected: Option<&RestartIdentity>,
    request: StopRequest,
) -> Result<(), crate::host::HostError> {
    let current =
        active_service(data_root)?.ok_or_else(|| "native_service_instance_changed".to_owned())?;
    if !same_instance(&current, record, expected) {
        return Err("native_service_instance_changed".into());
    }
    if !instance_is_locked(data_root)? || !process_matches(&current)? {
        return Err("native_service_instance_ambiguous: refusing signal".into());
    }
    signal_intended_stop(data_root, &current, request)
}

/// Announces the stop to supervisors, then asks the instance to stop
/// (SIGTERM). The intent is written before the request so it is on disk when
/// the process exits; a request that could not be delivered withdraws it
/// again.
fn signal_intended_stop(
    data_root: &Path,
    current: &InstanceRecord,
    request: StopRequest,
) -> Result<(), crate::host::HostError> {
    write_stop_intent(data_root, &StopIntent::new(request, current)).map_err(|source| {
        crate::host::HostError::new("native_service_stop_intent_unavailable").with_source(source)
    })?;
    match request_stop(current) {
        Ok(()) => Ok(()),
        Err(error) if error.message() == "native_service_process_exited" => Ok(()),
        Err(error) => match withdraw_stop_intent(data_root, &current.nonce) {
            Ok(()) => Err(error),
            Err(withdraw) => Err(error.with_source(withdraw)),
        },
    }
}

/// The instance keeps running after an undelivered stop, so its record goes
/// back to the state [`mark_stopping`] replaced (a record that changed since
/// is left alone); `stop` is the error returned.
fn revert_undelivered_stop(
    data_root: &Path,
    installation: &ResolvedInstallation,
    record: &InstanceRecord,
    previous: StoppingFrom,
    stop: crate::host::HostError,
) -> crate::host::HostError {
    match revert_stopping(data_root, &record.nonce, previous, installation) {
        Ok(()) => stop,
        Err(revert) => crate::host::HostError::new(stop.message().to_owned())
            .with_source(UndeliveredStopRevertFailed { revert, stop }),
    }
}

/// Waits for the signalled instance to exit, force-killing it after
/// [`STOP_TIMEOUT`] when it is still the same process. Returns whether it had
/// to be killed.
async fn wait_or_force_stop(
    data_root: &Path,
    record: &InstanceRecord,
    expected: Option<&RestartIdentity>,
) -> Result<bool, crate::host::HostError> {
    if wait_for_stop(data_root, &record.nonce, STOP_TIMEOUT).await? {
        return Ok(false);
    }
    let current =
        active_service(data_root)?.ok_or_else(|| "native_service_instance_changed".to_owned())?;
    if !same_instance(&current, record, expected) {
        return Ok(false);
    }
    // Re-read the lock, nonce, PID, OS start identity, and executable directly
    // before force-killing the recorded service process.
    if !instance_is_locked(data_root)? || !process_matches(&current)? {
        return Err("native_service_instance_ambiguous: refusing force kill".into());
    }
    if is_managed(data_root, &current) {
        // A signal sent straight to a supervised process looks like a crash
        // to its manager, which would relaunch it: the manager stops it.
        request(butler_platform::service_registration::stop).await?;
    } else if manager_unreachable(data_root).await {
        // The job is this DATA's but the manager does not answer, so the
        // service may be running under it: a kill could be answered by a
        // relaunch. Nothing is forced.
        return Err(
            "native_service_manager_unavailable: the service did not stop and its login job cannot be reached; stop it through the service manager"
                .into(),
        );
    } else {
        force_stop(&current)?;
    }
    if !wait_for_stop(data_root, &record.nonce, FORCE_STOP_TIMEOUT).await? {
        return Err("native_service_stop_timeout".into());
    }
    Ok(true)
}
