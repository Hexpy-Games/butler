//! Execution-owned durable operation-result replay.

mod anchors;
mod arguments;
mod contracts;
mod reference;
mod runtime;

pub(crate) use anchors::latest_work_anchor_indices;
pub(crate) use contracts::*;
pub(crate) use runtime::OperationResultReplayFactory;

#[cfg(test)]
mod tests;
