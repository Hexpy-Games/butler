//! The `stopping` transition of the instance record, and its revert when the
//! stop never reaches the instance.

use std::path::Path;

use super::record::{
    acquire_record_update_lock, instance_record_path, read_record_at, record_update_lock_path,
    write_record,
};
use super::validate_write_destinations;
use crate::host::ResolvedInstallation;

/// The record state [`mark_stopping`] found, so a stop that is never delivered
/// can put it back.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StoppingFrom {
    /// The instance was still starting.
    Starting,
    /// The instance was ready.
    Ready,
    /// An earlier controller had already marked it stopping.
    Stopping,
}

impl StoppingFrom {
    /// The record state to put back, if any.
    fn restored_state(self) -> Option<&'static str> {
        match self {
            Self::Starting => Some("starting"),
            Self::Ready => Some("ready"),
            Self::Stopping => None,
        }
    }
}

/// Marks the instance `nonce` names as stopping, so a late readiness cannot
/// overwrite the stop, and reports the state it replaced.
pub(crate) fn mark_stopping(
    data_root: &Path,
    nonce: &str,
    installation: &ResolvedInstallation,
) -> Result<StoppingFrom, crate::host::HostError> {
    validate_write_destinations(data_root, installation)?;
    let path = instance_record_path(data_root);
    let _record_update_lock = acquire_record_update_lock(&record_update_lock_path(data_root))?;
    let mut record = read_record_at(&path)?.ok_or_else(|| {
        "native_service_instance_ambiguous: instance record is missing".to_owned()
    })?;
    if record.nonce != nonce {
        return Err("native_service_instance_changed".into());
    }
    let previous = match record.state.as_str() {
        "starting" => StoppingFrom::Starting,
        "ready" => StoppingFrom::Ready,
        "stopping" => return Ok(StoppingFrom::Stopping),
        _ => return Err("native_service_instance_ambiguous: invalid stop transition".into()),
    };
    record.state = "stopping".into();
    write_record(&path, &record)?;
    Ok(previous)
}

/// Puts back the state [`mark_stopping`] replaced after the stop could not be
/// delivered (the intent could not be written, or SIGTERM failed): the
/// instance keeps running and must not stay half stopped, refusing gateway
/// control and failing readiness waiters. A record that changed since (another
/// nonce, or no longer `stopping`) is left alone.
pub(crate) fn revert_stopping(
    data_root: &Path,
    nonce: &str,
    previous: StoppingFrom,
    installation: &ResolvedInstallation,
) -> Result<(), crate::host::HostError> {
    let Some(restored) = previous.restored_state() else {
        return Ok(());
    };
    validate_write_destinations(data_root, installation)?;
    let path = instance_record_path(data_root);
    let _record_update_lock = acquire_record_update_lock(&record_update_lock_path(data_root))?;
    let Some(mut record) = read_record_at(&path)? else {
        return Ok(());
    };
    if record.nonce != nonce || record.state != "stopping" {
        return Ok(());
    }
    record.state = restored.into();
    write_record(&path, &record)
}
