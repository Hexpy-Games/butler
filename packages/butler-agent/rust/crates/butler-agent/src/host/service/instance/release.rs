//! Ending DATA ownership: the record goes, then the DATA lock, inside one
//! hold of the record lock (see `observe` for the lock order).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use butler_platform::instance::InstanceLock;

use super::record::{self, read_record_at, record_update_lock_path};
use super::{record_fault, validate_write_destinations};
use crate::host::ResolvedInstallation;
use crate::host::service::shutdown_trace::event;

/// What an instance releases at shutdown: its record and its DATA lock.
/// Clones share the lock, so the shutdown deadline can release it before a
/// forced exit as well as normal shutdown.
#[derive(Clone)]
pub(crate) struct InstanceRelease(Arc<Owned>);

struct Owned {
    record_path: PathBuf,
    installation: ResolvedInstallation,
    nonce: String,
    /// Taken only while the record lock is held, or on its failure path.
    data_lock: Mutex<Option<InstanceLock>>,
}

impl InstanceRelease {
    pub(super) fn new(
        record_path: PathBuf,
        installation: ResolvedInstallation,
        nonce: String,
        data_lock: InstanceLock,
    ) -> Self {
        Self(Arc::new(Owned {
            record_path,
            installation,
            nonce,
            data_lock: Mutex::new(Some(data_lock)),
        }))
    }

    pub(crate) fn nonce(&self) -> &str {
        &self.0.nonce
    }

    /// Whether this instance still holds the DATA lock.
    pub(super) fn holds_data(&self) -> bool {
        self.0
            .data_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    /// Normal shutdown: waits for the record lock.
    pub(super) fn release(&self) {
        self.release_with(true);
    }

    /// Forced exit: waits for the record lock only briefly; a record writer
    /// stalled in this process cannot keep the instance from ending.
    pub(crate) fn release_on_deadline(&self) {
        self.release_with(false);
    }

    fn release_with(&self, wait: bool) {
        let owned = &self.0;
        let record_lock =
            remove_record(&owned.record_path, &owned.installation, &owned.nonce, wait);
        record_fault::hold(if wait { "release" } else { "deadline" });
        let data_lock = owned
            .data_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if data_lock.is_some() {
            drop(data_lock);
            event("instance_release:data_unlocked");
        }
        drop(record_lock);
    }
}

/// Removes this instance's record; returns the record lock when it was taken,
/// so DATA is unlocked before readers can look again.
fn remove_record(
    record_path: &Path,
    installation: &ResolvedInstallation,
    nonce: &str,
    wait: bool,
) -> Option<InstanceLock> {
    event(if wait {
        "instance_release:begin"
    } else {
        "deadline_instance_release:begin"
    });
    let Some(data_root) = record_path.parent().and_then(Path::parent) else {
        event("instance_release:invalid_path");
        return None;
    };
    if validate_write_destinations(data_root, installation).is_err() {
        event("instance_release:invalid_destination");
        return None;
    }
    if !wait {
        record::fence_deadline_writes();
    }
    let lock_path = record_update_lock_path(data_root);
    let lock = if wait {
        record::acquire_record_update_lock(&lock_path).ok()
    } else {
        match record::acquire_record_update_lock_until(
            &lock_path,
            std::time::Duration::from_secs(1),
        ) {
            Ok(lock) => lock,
            Err(_) => {
                event("instance_release:record_lock_failed");
                return None;
            }
        }
    };
    if lock.is_none() {
        event("instance_release:record_lock_unavailable");
        if wait || record::cancel_staged_write(record_path, nonce).is_err() {
            event("instance_release:staged_write_cancel_failed");
            return None;
        }
    }
    if read_record_at(record_path)
        .ok()
        .flatten()
        .is_some_and(|current| current.nonce == nonce)
    {
        match fs::remove_file(record_path) {
            Ok(()) => event("instance_release:removed"),
            Err(error) => event(&format!(
                "instance_release:remove_failed:{:?}",
                error.kind()
            )),
        }
    } else {
        event("instance_release:record_missing_changed_or_unreadable");
    }
    lock
}
