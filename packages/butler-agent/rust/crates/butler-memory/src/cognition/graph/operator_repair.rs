//! Operator-owned projection policy and pinned-input repair transactions.

mod policy;
mod repair;
mod request;

pub use policy::{ProjectionModelPolicy, ProjectionModelPolicyInput, ProjectionModelSlot};
pub use repair::{CandidateInputRepairResult, RepairMode, RepairReceipt};
pub(in crate::cognition) use request::CandidateInputRepairRequest;

use crate::cognition::CognitionCode;
use std::path::Path;

use crate::cognition::{CognitionError, CognitionResult};
use butler_turn::conversation::ConversationSourceReader;

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
        mode: RepairMode,
        now: &str,
    ) -> CognitionResult<CandidateInputRepairResult> {
        repair::repair_candidate_inputs(
            self.connection_mut()?,
            &repair::RepairScope {
                current_generation,
                canonical,
                source_root,
                mode,
                now,
            },
            request,
        )
    }
}

pub(super) fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
