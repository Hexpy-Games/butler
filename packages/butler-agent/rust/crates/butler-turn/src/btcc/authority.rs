//! Principal authority decisions over durable, session-bound operations.

mod admission;
pub(in crate::btcc) mod approval;
pub(in crate::btcc) mod contracts;
mod decision;
mod execution;
mod identity;
mod permission;
mod permission_management;
mod projection;
pub(super) mod questions;
mod receipt;
mod service;

#[cfg(any(test, feature = "test-support"))]
pub(crate) use contracts::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityDecisionInput,
    AuthorityExecutionInput, AuthorityOutcomeInput, PrincipalAuthority,
};

#[cfg(test)]
mod question_validation;
#[cfg(test)]
mod tests;
