//! Durable generic consolidation cycle; phase effects belong to required ports.

mod checkpoint;
mod engine;
mod result;
mod types;

pub use engine::{CycleEventSink, CycleService, PhaseError, PhaseExecutor, RunCycle};
pub use types::{CycleStatus, Phase};
