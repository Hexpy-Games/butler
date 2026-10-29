//! Principal authority decisions over durable, session-bound operations.

mod action_identity;
mod admission;
pub(in crate::btcc) mod approval;
pub(in crate::btcc) mod contracts;
mod decision;
mod execution;
mod identity;
pub(super) mod pending_asks;
mod permission;
mod permission_management;
mod projection;
pub(super) mod questions;
mod receipt;
pub(super) mod resolve_ask;
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
