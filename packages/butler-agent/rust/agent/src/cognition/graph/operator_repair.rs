//! Operator-owned projection policy and pinned-input repair transactions.

mod policy;
mod repair;
mod request;

pub(in crate::cognition) use policy::ProjectionModelPolicy;
pub(crate) use policy::ProjectionModelPolicyInput;
pub(in crate::cognition) use repair::CandidateInputRepairResult;
pub(in crate::cognition) use request::CandidateInputRepairRequest;

use std::path::Path;

use crate::{
    cognition::{CognitionError, CognitionResult},
    conversation::ConversationSourceReader,
};

impl super::GraphRepository {
    pub(in crate::cognition) fn configure_projection_model_policy(
        &mut self,
        policy: &ProjectionModelPolicyInput,
        now: &str,
    ) -> CognitionResult<ProjectionModelPolicy> {
        policy::configure_projection_model_policy(self.connection_mut()?, policy, now)
    }

    pub(in crate::cognition) fn repair_candidate_inputs(
        &mut self,
        current_generation: &str,
        canonical: &ConversationSourceReader,
        source_root: &Path,
        request: &CandidateInputRepairRequest,
        dry_run: bool,
        now: &str,
    ) -> CognitionResult<CandidateInputRepairResult> {
        repair::repair_candidate_inputs(
            self.connection_mut()?,
            current_generation,
            canonical,
            source_root,
            request,
            dry_run,
            now,
        )
    }
}

pub(super) fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
