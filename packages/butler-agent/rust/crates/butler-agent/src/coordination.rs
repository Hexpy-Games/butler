//! Cross-domain writer fencing shared by native Profile and Cognition stores.

mod coordinator;
mod error;
mod fence;
mod inspect;
mod types;

pub(crate) use coordinator::{CognitionWriteCoordinator, CognitionWriteLease};
pub(crate) use error::{CoordinationError, CoordinationResult};
#[cfg(test)]
pub(crate) use types::LockInfo;
pub(crate) use types::{
    CognitionCoordinationHost, CognitionProcessStatus, CognitionWaitClass, CognitionWriteAcquire,
    ConsolidationLockState,
};

#[cfg(test)]
mod tests;
