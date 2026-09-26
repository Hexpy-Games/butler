//! Preparation belongs to one execution, before model routing and prompt rendering.

use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use crate::btcc::model_route::GuidedSourceRevision;
use crate::btcc::{
    AgentLoopProgress, BtccError, PortFuture, StateExecutionClaim, TurnContinuationBudgetPort,
    TurnRecord,
};

use super::contracts::SemanticTurn;
use super::{AuthorityDecision, GuidedPolicyDependencies, ModelRoundPort, OperationResultRuntime};

pub(crate) struct GuidedTurnStart<'a> {
    pub turn: &'a TurnRecord,
    pub claim: &'a StateExecutionClaim,
    pub progress: &'a dyn AgentLoopProgress,
    pub base: &'a dyn ModelRoundPort,
    pub cancellation: CancellationToken,
}

/// Factories retain process services. They must not retain bound Turn owners.
pub(crate) trait GuidedTurnFactory: Send + Sync {
    fn bind_pre_model<'a>(
        &'a self,
        start: GuidedTurnStart<'a>,
    ) -> PortFuture<'a, Box<dyn BoundGuidedTurn + 'a>>;
}

/// Taken once before the model execution borrows the owner's observed ports.
pub(crate) struct GuidedTurnInputs {
    pub semantic: SemanticTurn,
    pub dependencies: GuidedPolicyDependencies,
    pub authority_decision: Option<AuthorityDecision>,
    pub operation_results: Option<Arc<dyn OperationResultRuntime>>,
    pub budget: Option<Arc<dyn TurnContinuationBudgetPort>>,
    pub source_revision: GuidedSourceRevision,
}

pub(crate) trait BoundGuidedTurn: Send + Sync {
    fn take_inputs(&mut self) -> Result<GuidedTurnInputs, BtccError>;
    fn progress(&self) -> &dyn AgentLoopProgress;
    fn base(&self) -> &dyn ModelRoundPort;
}
