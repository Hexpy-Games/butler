use std::path::{Path, PathBuf};

use super::coordinator::CoordinatorInner;
use super::error::CoordinationResult;
use super::fence::{
    classify_unbound_fence, coordinator_path, is_busy, open_readwrite, read_known_coordinator,
};
use super::types::{ConsolidationLockInspection, ConsolidationLockState, LockInfo};

impl CoordinatorInner {
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
            return Ok(inspection(
                state,
                fence.legacy.clone(),
                fence.legacy,
                path,
                fence.reason,
            ));
        }
        let known = match read_known_coordinator(lock_path) {
            Ok(Some(known)) => known,
            Ok(None) => {
                return Ok(inspection(
                    ConsolidationLockState::Unavailable,
                    None,
                    None,
                    path,
                    Some("coordinator_unavailable"),
                ));
            }
            Err(error) => {
                let busy = error.is_busy();
                return Ok(inspection(
                    if busy {
                        ConsolidationLockState::Busy
                    } else {
                        ConsolidationLockState::Unavailable
                    },
                    None,
                    None,
                    path,
                    Some(if busy {
                        "coordinator_busy"
                    } else {
                        "coordinator_unavailable"
                    }),
                ));
            }
        };
        let connection = match open_readwrite(&path) {
            Ok(connection) => connection,
            Err(error) => {
                let busy = error.is_busy();
                return Ok(inspection(
                    if busy {
                        ConsolidationLockState::Busy
                    } else {
                        ConsolidationLockState::Unavailable
                    },
                    None,
                    known.last_owner,
                    path,
                    Some(if busy {
                        "coordinator_busy"
                    } else {
                        "coordinator_unavailable"
                    }),
                ));
            }
        };
        match connection.execute_batch("BEGIN IMMEDIATE") {
            Ok(()) => {
                let _ = connection.execute_batch("ROLLBACK");
                if known.fence_sha256.is_none() {
                    let fence =
                        classify_unbound_fence(lock_path, &self.hostname, self.host.as_ref())?;
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
                        fence.legacy.or(known.last_owner),
                        path,
                        fence.reason,
                    ))
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
            Err(error) if is_busy(&error) => Ok(inspection(
                ConsolidationLockState::Busy,
                None,
                known.last_owner,
                path,
                Some("coordinator_busy"),
            )),
            Err(_) => Ok(inspection(
                ConsolidationLockState::Unavailable,
                None,
                known.last_owner,
                path,
                Some("coordinator_unavailable"),
            )),
        }
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
