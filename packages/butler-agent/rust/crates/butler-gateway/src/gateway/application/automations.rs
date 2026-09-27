//! Persisted App automations, dispatch, and bounded lifecycle ownership.

mod contracts;
mod dispatch;
mod owner;
mod records;
mod scheduler;
mod store;

pub(crate) use contracts::*;
pub(crate) use owner::AutomationRunOwner;
pub(crate) use scheduler::AutomationScheduler;
