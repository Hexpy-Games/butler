//! Identity-checked, announced stop of the native service.

use std::path::Path;

use serde_json::{Value, json};

use super::readiness::wait_for_stop;
use super::{FORCE_STOP_TIMEOUT, STOP_TIMEOUT, active_service};
use crate::host::ResolvedInstallation;
use crate::host::service::instance::{
    AdmissionLock, InstanceRecord, RestartIdentity, StopDelivery, StopIntent, StopRequest,
    StoppingFrom, force_stop, instance_is_locked, mark_stopping, process_matches,
    refuse_live_legacy_process, remove_shutdown_flag, request_stop, revert_stopping,
    withdraw_stop_intent, write_stop_intent,
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
/// in the intent file, requests the stop (SIGTERM, or `service_stop` on
/// Windows) and waits, force-killing after [`STOP_TIMEOUT`]. A stop that is
/// never delivered leaves the record as it was.
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
    let previous = mark_stopping(data_root, &record.nonce, installation)?;
    let delivery = match deliver_stop(data_root, &record, expected, request).await {
        Ok(delivery) => delivery,
        Err(error) => {
            return Err(revert_undelivered_stop(
                data_root,
                installation,
                &record,
                previous,
                error,
            ));
        }
    };
    let forced = wait_or_force_stop(data_root, &record, expected).await;
    if delivery == Some(StopDelivery::ShutdownFlag)
        && let Err(error) = remove_shutdown_flag(data_root)
    {
        return Err(
            crate::host::HostError::new("native_service_shutdown_flag_unavailable")
                .with_source(error),
        );
    }
    let forced = forced?;
    let stopped = StoppedInstance {
        pid: record.pid,
        nonce: record.nonce,
        forced,
        app_supervised: record.app_supervised,
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
/// delivered; `None` means the instance had exited already.
async fn deliver_stop(
    data_root: &Path,
    record: &InstanceRecord,
    expected: Option<&RestartIdentity>,
    request: StopRequest,
) -> Result<Option<StopDelivery>, crate::host::HostError> {
    let current =
        active_service(data_root)?.ok_or_else(|| "native_service_instance_changed".to_owned())?;
    if !same_instance(&current, record, expected) {
        return Err("native_service_instance_changed".into());
    }
    if !instance_is_locked(data_root)? || !process_matches(&current)? {
        return Err("native_service_instance_ambiguous: refusing signal".into());
    }
    signal_intended_stop(data_root, &current, request).await
}

/// Announces the stop to supervisors, then asks the instance to stop
/// (SIGTERM or `service_stop`). The intent is written before the request so
/// it is on disk when the process exits (and so the instance can check a
/// `service_stop` against it); a request that could not be delivered
/// withdraws it again.
async fn signal_intended_stop(
    data_root: &Path,
    current: &InstanceRecord,
    request: StopRequest,
) -> Result<Option<StopDelivery>, crate::host::HostError> {
    write_stop_intent(data_root, &StopIntent::new(request, current)).map_err(|source| {
        crate::host::HostError::new("native_service_stop_intent_unavailable").with_source(source)
    })?;
    match request_stop(data_root, current).await {
        Ok(delivery) => Ok(Some(delivery)),
        Err(error) if error.message() == "native_service_process_exited" => Ok(None),
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
    force_stop(&current)?;
    if !wait_for_stop(data_root, &record.nonce, FORCE_STOP_TIMEOUT).await? {
        return Err("native_service_stop_timeout".into());
    }
    Ok(true)
}
