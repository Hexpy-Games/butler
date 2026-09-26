use std::path::PathBuf;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::error::CoordinationResult;

pub(crate) trait CognitionCoordinationHost: Send + Sync {
    fn process_id(&self) -> u32;
    fn hostname(&self) -> CoordinationResult<String>;
    fn process_status(&self, pid: u64) -> CognitionProcessStatus;
    fn new_uuid(&self) -> String;
    fn now_epoch_millis(&self) -> i64;
    fn now_iso(&self) -> String;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CognitionProcessStatus {
    Alive,
    DefinitelyDead,
    Uncertain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CognitionWaitClass {
    Interactive,
    Background,
}

#[derive(Clone, Debug)]
pub(crate) struct CognitionWriteAcquire {
    pub(crate) lock_path: PathBuf,
    pub(crate) purpose: Option<String>,
    pub(crate) deadline_at_epoch_ms: Option<f64>,
    pub(crate) cancellation: Option<CancellationToken>,
}

impl CognitionWriteAcquire {
    pub(crate) fn immediate(lock_path: PathBuf, purpose: impl Into<String>) -> Self {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ConsolidationLockState {
    Free,
    InitializationAvailable,
    Held,
    Busy,
    LegacyBlocked,
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
