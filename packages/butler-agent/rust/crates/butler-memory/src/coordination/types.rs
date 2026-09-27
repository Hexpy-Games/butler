use std::path::PathBuf;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::error::CoordinationResult;

/// Process, host and clock facts the writer coordinator needs.
pub trait CognitionCoordinationHost: Send + Sync {
    /// This process id.
    fn process_id(&self) -> u32;
    /// This host name.
    fn hostname(&self) -> CoordinationResult<String>;
    /// Whether the process with `pid` is alive.
    fn process_status(&self, pid: u64) -> CognitionProcessStatus;
    /// A fresh unique id.
    fn new_uuid(&self) -> String;
    /// Now, in milliseconds since the Unix epoch.
    fn now_epoch_millis(&self) -> i64;
    /// Now, as an ISO 8601 time with milliseconds.
    fn now_iso(&self) -> String;
}

/// Whether a lock owner process is still running.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CognitionProcessStatus {
    /// The process is running.
    Alive,
    /// The process is certainly gone.
    DefinitelyDead,
    /// The process may or may not be running.
    Uncertain,
}

/// How long a writer waits for the lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CognitionWaitClass {
    /// A user is waiting: poll quickly.
    Interactive,
    /// Background work: poll slowly.
    Background,
}

/// A request for the memory writer lock.
#[derive(Clone, Debug)]
pub struct CognitionWriteAcquire {
    /// Lock file guarding the store.
    pub lock_path: PathBuf,
    /// What the writer is for, recorded with the owner.
    pub purpose: Option<String>,
    /// Give up after this time (milliseconds since the epoch).
    pub deadline_at_epoch_ms: Option<f64>,
    /// Give up when cancelled.
    pub cancellation: Option<CancellationToken>,
}

impl CognitionWriteAcquire {
    /// A request that fails at once when the lock is held.
    pub fn immediate(lock_path: PathBuf, purpose: impl Into<String>) -> Self {
        Self {
            lock_path,
            purpose: Some(purpose.into()),
            deadline_at_epoch_ms: None,
            cancellation: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct LockInfo {
    pub(crate) pid: u64,
    #[serde(rename = "startedAt")]
    pub(crate) started_at: String,
    pub(crate) host: String,
    pub(crate) owner_nonce: String,
    pub(crate) purpose: String,
}

/// State of the consolidation lock as seen without taking it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsolidationLockState {
    /// Nobody holds it.
    Free,
    /// No coordinator exists yet and one may be created.
    InitializationAvailable,
    /// This process holds it.
    Held,
    /// Another writer holds it.
    Busy,
    /// A legacy fence owner that may be alive blocks it.
    LegacyBlocked,
    /// The lock cannot be inspected.
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConsolidationLockInspection {
    pub(crate) state: ConsolidationLockState,
    pub(crate) pid: Option<u64>,
    pub(crate) owner: Option<LockInfo>,
    pub(crate) last_observed_owner: Option<LockInfo>,
    pub(crate) coordinator_path: PathBuf,
    pub(crate) reason: Option<&'static str>,
}
