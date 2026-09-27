//! Execution-owned durable operation-result replay.

mod anchors;
mod arguments;
mod contracts;
mod reference;
mod runtime;

pub use anchors::latest_work_anchor_indices;
pub use contracts::*;
pub use runtime::OperationResultReplayFactory;

#[cfg(test)]
mod tests;
