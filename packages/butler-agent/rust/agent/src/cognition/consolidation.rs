//! Durable generic consolidation cycle; phase effects belong to required ports.

mod checkpoint;
mod engine;
mod result;
mod types;

pub(crate) use engine::{CycleEventSink, CycleService, PhaseError, PhaseExecutor, RunCycle};
pub(crate) use types::{CycleStatus, Phase};
