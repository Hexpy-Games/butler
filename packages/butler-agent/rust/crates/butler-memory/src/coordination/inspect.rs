//! Inspecting the consolidation lock without taking it.

use std::path::{Path, PathBuf};

use super::coordinator::CoordinatorInner;
use super::error::CoordinationResult;
use super::fence::{
    classify_unbound_fence, coordinator_path, is_busy, open_readwrite,
    read_known_coordinator_for_acquire,
};
use super::types::{ConsolidationLockInspection, ConsolidationLockState, LockInfo};

impl CoordinatorInner {
    /// The consolidation lock's state as seen from this process, without
    /// taking it.
    pub(super) fn inspect(
        &self,
        lock_path: &Path,
    ) -> CoordinationResult<ConsolidationLockInspection> {
        let path = coordinator_path(lock_path);
        if let Some(local) = self.local.lock().get(lock_path).cloned() {
            return Ok(inspection(
                ConsolidationLockState::Held,
                Some(local.owner.clone()),
                Some(local.owner),
                path,
                None,
            ));
        }
        if !path.exists() {
            return self.inspect_uninitialized(lock_path, path);
        }
        // Inspection already probes the writable SQLite gate below. Recover its hot
        // rollback journal first, before a read-only metadata query can refuse it.
        let known = match read_known_coordinator_for_acquire(lock_path) {
            Ok(Some(known)) => known,
            Ok(None) => return Ok(Blocked::Unavailable.inspection(path, None)),
            Err(error) => return Ok(Blocked::from_busy(error.is_busy()).inspection(path, None)),
        };
        let connection = match open_readwrite(&path) {
            Ok(connection) => connection,
            Err(error) => {
                return Ok(Blocked::from_busy(error.is_busy()).inspection(path, known.last_owner));
            }
        };
        match connection.execute_batch("BEGIN IMMEDIATE") {
            Ok(()) => {
                let _ = connection.execute_batch("ROLLBACK");
                if known.fence_sha256.is_none() {
                    self.inspect_unbound(lock_path, path, known.last_owner)
                } else {
                    Ok(inspection(
                        ConsolidationLockState::Free,
                        None,
                        known.last_owner,
                        path,
                        None,
                    ))
                }
            }
            Err(error) if is_busy(&error) => Ok(Blocked::Busy.inspection(path, known.last_owner)),
            Err(_) => Ok(Blocked::Unavailable.inspection(path, known.last_owner)),
        }
    }

    /// No coordinator database yet: the legacy fence decides whether one
    /// may be initialized.
    fn inspect_uninitialized(
        &self,
        lock_path: &Path,
        path: PathBuf,
    ) -> CoordinationResult<ConsolidationLockInspection> {
        let fence = classify_unbound_fence(lock_path, &self.hostname, self.host.as_ref())?;
        if fence.available {
            return Ok(inspection(
                ConsolidationLockState::InitializationAvailable,
                None,
                None,
                path,
                None,
            ));
        }
        let state = if fence.legacy.is_some() {
            ConsolidationLockState::LegacyBlocked
        } else {
            ConsolidationLockState::Unavailable
        };
        Ok(inspection(
            state,
            fence.legacy.clone(),
            fence.legacy,
            path,
            fence.reason,
        ))
    }

    /// A free coordinator not yet bound to a fence.
    fn inspect_unbound(
        &self,
        lock_path: &Path,
        path: PathBuf,
        last_owner: Option<LockInfo>,
    ) -> CoordinationResult<ConsolidationLockInspection> {
        let fence = classify_unbound_fence(lock_path, &self.hostname, self.host.as_ref())?;
        let state = if fence.available {
            ConsolidationLockState::InitializationAvailable
        } else if fence.legacy.is_some() {
            ConsolidationLockState::LegacyBlocked
        } else {
            ConsolidationLockState::Unavailable
        };
        Ok(inspection(
            state,
            fence.legacy.clone(),
            fence.legacy.or(last_owner),
            path,
            fence.reason,
        ))
    }
}

/// Why the coordinator could not be inspected.
#[derive(Clone, Copy)]
enum Blocked {
    Busy,
    Unavailable,
}

impl Blocked {
    fn from_busy(busy: bool) -> Self {
        if busy { Self::Busy } else { Self::Unavailable }
    }

    fn inspection(
        self,
        path: PathBuf,
        last_owner: Option<LockInfo>,
    ) -> ConsolidationLockInspection {
        let (state, reason) = match self {
            Self::Busy => (ConsolidationLockState::Busy, "coordinator_busy"),
            Self::Unavailable => (
                ConsolidationLockState::Unavailable,
                "coordinator_unavailable",
            ),
        };
        inspection(state, None, last_owner, path, Some(reason))
    }
}

fn inspection(
    state: ConsolidationLockState,
    owner: Option<LockInfo>,
    last_observed_owner: Option<LockInfo>,
    coordinator_path: PathBuf,
    reason: Option<&'static str>,
) -> ConsolidationLockInspection {
    ConsolidationLockInspection {
        state,
        pid: owner.as_ref().map(|value| value.pid),
        owner,
        last_observed_owner,
        coordinator_path,
        reason,
    }
}
