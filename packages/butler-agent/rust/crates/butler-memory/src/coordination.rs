//! Cross-domain writer fencing shared by native Profile and Cognition stores.

mod coordinator;
mod error;
mod fence;
mod inspect;
mod inventory;
pub(crate) use inventory::signal_inventory_change;
mod types;

pub use coordinator::{CognitionWriteCoordinator, CognitionWriteLease};
pub use error::{CoordinationError, CoordinationResult};
pub(crate) use types::LockInfo;
pub use types::{
    CognitionCoordinationHost, CognitionProcessStatus, CognitionWaitClass, CognitionWriteAcquire,
    ConsolidationLockState,
};

#[cfg(test)]
mod tests;
