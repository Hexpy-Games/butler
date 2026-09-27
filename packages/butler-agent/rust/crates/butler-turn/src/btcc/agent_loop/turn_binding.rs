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

/// What binding a guided turn borrows before its first model round.
pub struct GuidedTurnStart<'a> {
    pub turn: &'a TurnRecord,
    pub claim: &'a StateExecutionClaim,
    pub progress: &'a dyn AgentLoopProgress,
    pub base: &'a dyn ModelRoundPort,
    pub cancellation: CancellationToken,
}

/// Factories retain process services. They must not retain bound Turn owners.
pub trait GuidedTurnFactory: Send + Sync {
    /// Binds the guided turn's ports and inputs.
    fn bind_pre_model<'a>(
        &'a self,
        start: GuidedTurnStart<'a>,
    ) -> PortFuture<'a, Box<dyn BoundGuidedTurn + 'a>>;
}

/// Taken once before the model execution borrows the owner's observed ports.
pub struct GuidedTurnInputs {
    pub semantic: SemanticTurn,
    pub dependencies: GuidedPolicyDependencies,
    pub authority_decision: Option<AuthorityDecision>,
    pub operation_results: Option<Arc<dyn OperationResultRuntime>>,
    pub budget: Option<Arc<dyn TurnContinuationBudgetPort>>,
    pub source_revision: GuidedSourceRevision,
    /// Relays the provider's text deltas to progress while the loop runs.
    pub stream_relay: Option<super::stream_relay::StreamRelay>,
}

/// A guided turn bound for execution.
pub trait BoundGuidedTurn: Send + Sync {
    /// Takes the bound inputs; a second call is an error.
    fn take_inputs(&mut self) -> Result<GuidedTurnInputs, BtccError>;
    /// The progress sink scoped to this turn.
    fn progress(&self) -> &dyn AgentLoopProgress;
    /// The unrouted model port.
    fn base(&self) -> &dyn ModelRoundPort;
}
