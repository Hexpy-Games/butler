//! Principal authority decisions over durable, session-bound operations.

mod admission;
pub(in crate::btcc) mod approval;
pub(in crate::btcc) mod contracts;
mod decision;
mod execution;
mod identity;
mod permission;
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

/// Observations do not need a declared persistent Plan effect.
pub(crate) fn is_observation(capability: &str, input: &serde_json::Value) -> bool {
    matches!(
        capability,
        "ask_user" | "read_file" | "list_files" | "grep_files"
    ) || (capability == "run_command"
        && matches!(
            input.get("state_effect").and_then(serde_json::Value::as_str),
            Some("read_only" | "validation")
        ))
}
