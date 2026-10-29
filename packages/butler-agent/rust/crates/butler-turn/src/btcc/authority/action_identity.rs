//! Logical operation identity retains all normalized arguments, independent of card presentation.
use super::contracts::{AuthorityAdmissionInput, AuthorityResult, PrincipalAuthority};
use serde_json::json;

impl PrincipalAuthority {
    /// Excludes call occurrence and permission policy, which do not change the action.
    pub fn action_identity(&self, input: &AuthorityAdmissionInput) -> AuthorityResult<String> {
        let facts = json!({"capability":input.capability,"target":input.target,
            "input":input.normalized_input});
        Ok(super::identity::digest(&super::identity::canonical(
            &facts,
            &self.collation,
        )?))
    }
}
