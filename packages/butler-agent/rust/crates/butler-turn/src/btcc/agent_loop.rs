//! BTCC-owned semantic model/tool loop.

mod completion;
mod continuation;
/// Model-round, tool and continuation contracts of the loop.
pub mod contracts;
mod driver;
mod guided_policy;
/// The ports a guided turn is composed of.
pub mod guided_ports;
mod guided_types;
mod model_round;
pub mod operation_result_replay;
mod ports;
mod progress;
mod state;
mod tool_batch;
mod turn_binding;

#[cfg(any(test, feature = "test-support"))]
pub mod fixture_binding;

use crate::btcc::BtccCode;
pub use contracts::SemanticTurn;
pub use turn_binding::{BoundGuidedTurn, GuidedTurnFactory, GuidedTurnInputs, GuidedTurnStart};

#[cfg(test)]
mod failure_tests;
#[cfg(any(test, feature = "test-support"))]
mod guided_fixture;
#[cfg(test)]
mod round_contract_tests;
#[cfg(any(test, feature = "test-support"))]
pub mod test_data;
#[cfg(any(test, feature = "test-support"))]
mod test_execution;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::{future::Future, pin::Pin};

use tokio_util::sync::CancellationToken;

use crate::btcc::{
    AgentLoop, AgentLoopError, AgentLoopProgress, AgentLoopResult, BtccError, StateExecutionClaim,
    TurnRecord,
};

pub use continuation::{
    ActivityGroup, AuthorityLoopContinuation, GuidedActivityBinding, GuidedActivitySnapshot,
    GuidedPresentation, PendingTool,
};
pub use contracts::{
    AcceptedCheckpoint, AuthorityDecision, BatchDisposition, BoundedContinuationEnvelope,
    BoundedEnvelopeV1, CandidateDisposition, ContextMessages, ContextProjection,
    ContextProjectionInput, ContextProjectionRebaseIdentity, ContextProjectionRebaseV1,
    ContextRebase, LoopPhase, ModelRoundMessage, ModelRoundRequest, ModelRoundResult,
    ModelRoundRole, ModelRoundTool, ModelRoundToolCall, ProviderIdentity, RollingContextV1,
    SteeringObservation, TextCallDisposition, ToolCallOrigin, ToolChoice, ToolOutcome, ToolResult,
    ToolSurface, UsageAttribution,
};
pub use guided_ports::{
    AuthorityPort, ContextPort, FinalSynthesis, GuidedInvocation, GuidedPolicyDependencies,
    JournalCloseout, JournalPort, PromptImages, PromptPort, RenderedGuidedPrompt,
    RoundRequestOptions, ToolPort, TurnContextProjection, TurnSteeringPort, WorkFinalState,
    WorkPort,
};
#[cfg(any(test, feature = "test-support"))]
pub use operation_result_replay::OperationResultReference;
#[cfg(any(test, feature = "test-support"))]
pub(crate) use operation_result_replay::TurnWorkScopePort;
pub use operation_result_replay::{
    ExactResultReplaySelection, OperationResultMessageReferences, OperationResultReplayFactory,
    OperationResultRuntime, OperationResultRuntimeFactory, OperationResultScope, ReplayMode,
    latest_work_anchor_indices,
};
#[cfg(any(test, feature = "test-support"))]
pub(crate) use ports::NoopModelRoundObserver;
#[cfg(any(test, feature = "test-support"))]
pub static NOOP_MODEL_ROUND_OBSERVER: NoopModelRoundObserver = NoopModelRoundObserver;
pub use ports::{
    AgentLoopObserver, ContextProjectionError, ModelRoundError, ModelRoundObserver, ModelRoundPort,
    ProviderBodyAdmissionPort, ProviderStreamObserver, ToolExecutionError,
    VerifiedImagePayloadPort,
};

use driver::run;

/// The agent loop used in production: binds a guided turn, routes its model and runs the loop.
pub struct ProductionAgentLoop {
    model: Arc<dyn ModelRoundPort>,
    execution_factory: Arc<dyn crate::btcc::model_route::ModelExecutionFactory>,
    factory: Arc<dyn GuidedTurnFactory>,
    observer: Option<Arc<dyn AgentLoopObserver>>,
}

impl ProductionAgentLoop {
    /// A loop over the model port, route execution factory and guided turn factory.
    pub fn native(
        model: Arc<dyn ModelRoundPort>,
        execution_factory: Arc<dyn crate::btcc::model_route::ModelExecutionFactory>,
        factory: Arc<dyn GuidedTurnFactory>,
        observer: Option<Arc<dyn AgentLoopObserver>>,
    ) -> Self {
        Self {
            model,
            execution_factory,
            factory,
            observer,
        }
    }
}

impl AgentLoop for ProductionAgentLoop {
    fn run<'a>(
        &'a self,
        turn: &'a TurnRecord,
        claim: &'a StateExecutionClaim,
        recovery_attempt: u32,
        progress: &'a dyn AgentLoopProgress,
        model_round_observer: &'a dyn crate::btcc::ModelRoundObserver,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<AgentLoopResult, AgentLoopError>> + Send + 'a>> {
        Box::pin(async move {
            let Self {
                model,
                execution_factory,
                factory,
                observer,
            } = self;
            let mut owner = factory
                .bind_pre_model(GuidedTurnStart {
                    turn,
                    claim,
                    progress,
                    base: model.as_ref(),
                    cancellation: cancellation.clone(),
                })
                .await
                .map_err(AgentLoopError::Propagate)?;
            let inputs = owner.take_inputs().map_err(AgentLoopError::Propagate)?;
            let policy =
                guided_policy::GuidedPolicy::bound(inputs.dependencies, inputs.authority_decision);
            let execution = execution_factory
                .create(crate::btcc::model_route::ModelExecutionInput {
                    source_revision: inputs.source_revision,
                    turn,
                    claim,
                    progress: owner.progress(),
                    model_round_observer,
                    cancellation: cancellation.clone(),
                    base: owner.base(),
                })
                .await
                .map_err(AgentLoopError::Propagate)?;
            run(driver::Invocation {
                turn,
                #[cfg(any(test, feature = "test-support"))]
                claim,
                recovery_attempt,
                progress: owner.progress(),
                model_round_observer,
                semantic: inputs.semantic,
                cancellation,
                model: execution.routed(),
                model_execution: execution.as_ref(),
                policy: &policy,
                operation_results: inputs.operation_results.as_deref(),
                budget: inputs.budget,
                observer: observer.as_deref(),
            })
            .await
        })
    }
}

fn invalid_contract(code: BtccCode) -> BtccError {
    BtccError::detected(code, code.as_str())
}
