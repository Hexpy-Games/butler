//! Principal authority decisions over durable, session-bound operations.

mod admission;
pub(in crate::btcc) mod contracts;
mod decision;
mod execution;
mod identity;
mod permission;
mod projection;
mod receipt;
mod service;

#[cfg(test)]
pub(crate) use contracts::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityDecisionInput,
    AuthorityExecutionInput, AuthorityOutcomeInput, NativePrincipalAuthority,
};

#[cfg(test)]
mod tests;
