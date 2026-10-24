//! How readers see DATA ownership: the DATA lock and the instance record
//! together, never halfway through a change.
//!
//! Lock order, for every holder: the record lock, then the DATA lock.
//! Startup takes DATA and publishes its record, shutdown removes the record
//! and unlocks DATA, and a stopped-service writer takes DATA, each inside one
//! exclusive hold of the record lock. A reader holds the record lock shared
//! while it probes DATA and reads the record. No code may take the record
//! lock while its thread already holds it: a second handle in the same
//! process waits for the first forever.

use std::{fs, fs::File, fs::OpenOptions, io, path::Path};

use butler_platform::instance::{InstanceLock, LockError};

use super::record::record_update_lock_path;
use super::{InstanceRecord, instance_lock_path, read_record};

/// Error of a DATA lock held without a matching instance record. Instances
/// publish their record in the same record-lock hold that takes DATA, so the
/// owner is a stopped-service writer: a settings change, or a starting
/// service that recovers an interrupted reset before it takes the instance.
pub(crate) const DATA_BUSY: &str =
    "native_service_data_busy: another process is using this DATA without a service record";

/// The DATA lock and the instance record, observed at one moment.
pub(crate) struct Ownership {
    pub(crate) locked: bool,
    pub(crate) record: Option<InstanceRecord>,
}

/// Observes DATA ownership between transitions; waits while one is in
/// progress.
pub(crate) fn observe(data_root: &Path) -> Result<Ownership, crate::host::HostError> {
    let mut serial = serialize(data_root)?;
    if serial.is_none() && data_lock_held(data_root)? {
        // Owners create the record lock before they take DATA, so it exists
        // now (the first start of this DATA raced the check above).
        serial = serialize(data_root)?;
    }
    let ownership = Ownership {
        locked: data_lock_held(data_root)?,
        record: read_record(data_root)?,
    };
    drop(serial);
    Ok(ownership)
}

/// [`observe`] off the async runtime: it can wait for a transition.
pub(crate) async fn observe_async(data_root: &Path) -> Result<Ownership, crate::host::HostError> {
    let data_root = data_root.to_path_buf();
    tokio::task::spawn_blocking(move || observe(&data_root))
        .await
        .map_err(crate::host::HostError::from_error)?
}

/// Whether an owner holds the DATA lock, observed between transitions.
pub(crate) fn instance_is_locked(data_root: &Path) -> Result<bool, crate::host::HostError> {
    observe(data_root).map(|ownership| ownership.locked)
}

/// [`instance_is_locked`] off the async runtime.
pub(crate) async fn instance_is_locked_async(
    data_root: &Path,
) -> Result<bool, crate::host::HostError> {
    observe_async(data_root)
        .await
        .map(|ownership| ownership.locked)
}

/// The shared record lock, or `None` where no owner has created it yet.
fn serialize(data_root: &Path) -> Result<Option<InstanceLock>, crate::host::HostError> {
    let Some(file) = open_existing(&record_update_lock_path(data_root))? else {
        return Ok(None);
    };
    crate::host::service::shutdown_trace::measure_sync("instance_observe_wait", || {
        InstanceLock::shared(file)
    })
    .map(Some)
    .map_err(|error| format!("native_service_record_lock_failed: {error}").into())
}

/// Probes the DATA lock with a shared lock: probes never conflict with each
/// other, and every exclusive taker holds the record lock this reader holds
/// shared.
fn data_lock_held(data_root: &Path) -> Result<bool, crate::host::HostError> {
    let Some(file) = open_existing(&instance_lock_path(data_root))? else {
        return Ok(false);
    };
    match InstanceLock::try_shared(file) {
        Ok(_) => Ok(false),
        Err(LockError::Busy) => Ok(true),
        Err(LockError::Failed(error)) => Err(format!("service_lock_probe_failed: {error}").into()),
    }
}

/// Opens a lock file for reading without creating it or its folder.
fn open_existing(path: &Path) -> Result<Option<File>, crate::host::HostError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("service_lock_unavailable".into()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("service_lock_path_ambiguous".into());
        }
        Ok(_) => {}
    }
    match OpenOptions::new().read(true).open(path) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => {
            Err(crate::host::HostError::new("service_lock_unavailable").with_source(source))
        }
    }
}
