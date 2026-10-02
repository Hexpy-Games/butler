//! Temporary candidate inventory/readiness facade; removed in stage 5.
mod build_inventory;
mod inventory;
pub(super) mod readiness;
#[cfg(test)]
mod tests;
pub(in crate::cognition) use inventory::MemorySourceInventory;
pub use readiness::{compute as compute_rebuild_readiness, record as record_rebuild_readiness};
