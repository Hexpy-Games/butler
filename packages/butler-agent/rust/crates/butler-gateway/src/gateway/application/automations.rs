//! Persisted App automations, dispatch, and bounded lifecycle ownership.

mod attention;
mod contracts;
mod dispatch;
mod holds;
mod occurrence;
mod owner;
pub(super) mod records;
mod scheduler;
mod store;
pub(super) mod timing;

#[cfg(test)]
pub(in crate::gateway::application) use records::queued_sql;

pub(crate) use contracts::*;
pub(crate) use owner::AutomationRunOwner;
pub(crate) use scheduler::AutomationScheduler;
pub(crate) use scheduler::signals;
#[cfg(feature = "e2e-fixtures")]
pub(crate) use scheduler::{dispatch_attempt_count, next_due_read_count};

pub(super) use store::read_targets;
