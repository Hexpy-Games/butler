//! Durable reviewed effects over accepted session Work.

mod blockers;
/// Effect journal, adapter and outcome contracts.
pub mod contracts;
mod execution;
mod identity;
mod outcomes;
pub(in crate::btcc) mod recovery;
mod service;
pub(crate) mod workspace_edit;
pub mod workspace_file;

pub use identity::{accepted_plan_effect_id, effect_input_sha256};
pub use service::EffectService;

#[cfg(any(test, feature = "test-support"))]
pub mod testing;
#[cfg(test)]
mod tests;
