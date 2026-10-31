//! Immutable workspace snapshots and one-time blob ownership recovery.
mod blobs;
mod index;
mod snapshot;
pub use index::OutputSummary;
mod store;
pub use store::{Output, OutputKind, OutputStore, PublishRequest, Revision};
