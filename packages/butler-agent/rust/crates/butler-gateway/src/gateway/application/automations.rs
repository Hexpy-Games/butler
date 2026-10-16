//! Persisted App automations, dispatch, and bounded lifecycle ownership.

mod attention;
mod contracts;
mod dispatch;
mod owner;
mod records;
mod scheduler;
mod store;
mod timing;

#[cfg(test)]
pub(in crate::gateway::application) use records::queued_sql;

pub(crate) use contracts::*;
pub(crate) use owner::AutomationRunOwner;
pub(crate) use scheduler::AutomationScheduler;
#[cfg(feature = "e2e-fixtures")]
pub(crate) use scheduler::next_due_read_count;
pub(crate) use scheduler::signals;

pub(super) use store::read_targets;
