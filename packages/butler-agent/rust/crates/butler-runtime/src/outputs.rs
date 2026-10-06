//! Immutable workspace snapshots. No timers or background writes.
mod index;
mod snapshot;
pub use index::OutputSummary;
mod store;
pub use store::{Output, OutputKind, OutputStore, PublishRequest, Revision};
