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

mod authority;
pub(crate) use authority::{ensure_data_authority, ensure_supported_data_authority};
mod admission;
pub(crate) use admission::{
    capture as capture_admission_floor, capture_project as capture_project_admission_floor,
    has_floor as has_admission_floor, suppressed as admission_suppressed,
};
