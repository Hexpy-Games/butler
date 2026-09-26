//! BTCC-owned semantic model/tool loop.

mod completion;
mod continuation;
mod contracts;
mod driver;
mod guided_policy;
mod guided_ports;
mod guided_types;
mod model_round;
mod operation_result_replay;
mod ports;
mod progress;
mod state;
mod tool_batch;
mod turn_binding;

#[cfg(test)]
mod fixture_binding;

pub(crate) use contracts::SemanticTurn;
pub(crate) use turn_binding::{
    BoundGuidedTurn, GuidedTurnFactory, GuidedTurnInputs, GuidedTurnStart,
};

#[cfg(test)]
mod context_loopback;
#[cfg(test)]
mod failure_tests;
#[cfg(test)]
mod guided_fixture;
#[cfg(test)]
mod native_loopback;
#[cfg(test)]
mod round_contract_tests;
#[cfg(test)]
mod test_data;
#[cfg(test)]
mod test_execution;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::{future::Future, pin::Pin};

use tokio_util::sync::CancellationToken;

use crate::btcc::{
    AgentLoop, AgentLoopError, AgentLoopProgress, AgentLoopResult, BtccError, StateExecutionClaim,
    TurnRecord,
};

pub(crate) use continuation::{
    ActivityGroup, AuthorityLoopContinuation, GuidedActivityBinding, GuidedActivitySnapshot,
    GuidedPresentation, PendingTool,
};
pub(crate) use contracts::{
    AcceptedCheckpoint, AuthorityDecision, BatchDisposition, BoundedContinuationEnvelope,
    BoundedEnvelopeV1, CandidateDisposition, ContextMessages, ContextProjection,
    ContextProjectionInput, ContextProjectionRebaseIdentity, ContextProjectionRebaseV1,
    ModelRoundMessage, ModelRoundRequest, ModelRoundResult, ModelRoundRole, ModelRoundTool,
    ModelRoundToolCall, ProviderIdentity, RollingContextV1, SteeringObservation,
    TextCallDisposition, ToolCallOrigin, ToolChoice, ToolOutcome, ToolResult, UsageAttribution,
};
pub(crate) use guided_ports::{
    AuthorityPort, ContextPort, GuidedInvocation, GuidedPolicyDependencies, JournalCloseout,
    JournalPort, PromptPort, RenderedGuidedPrompt, ToolPort, TurnContextProjection,
    TurnSteeringPort, WorkFinalState, WorkPort,
};
#[cfg(test)]
pub(crate) use operation_result_replay::OperationResultReference;
#[cfg(test)]
pub(crate) use operation_result_replay::TurnWorkScopePort;
pub(crate) use operation_result_replay::{
    ExactResultReplaySelection, OperationResultMessageReferences, OperationResultReplayFactory,
    OperationResultRuntime, OperationResultRuntimeFactory, OperationResultScope, ReplayMode,
    latest_work_anchor_indices,
};
#[cfg(test)]
pub(crate) use ports::NoopModelRoundObserver;
#[cfg(test)]
pub(crate) static NOOP_MODEL_ROUND_OBSERVER: NoopModelRoundObserver = NoopModelRoundObserver;
pub(crate) use ports::{
    AgentLoopObserver, ContextProjectionError, ModelRoundError, ModelRoundObserver, ModelRoundPort,
    ProviderBodyAdmissionPort, ProviderStreamObserver, ToolExecutionError,
    VerifiedImagePayloadPort,
};

use driver::run;

pub(crate) struct ProductionAgentLoop {
    model: Arc<dyn ModelRoundPort>,
    execution_factory: Arc<dyn crate::btcc::model_route::ModelExecutionFactory>,
    factory: Arc<dyn GuidedTurnFactory>,
    observer: Option<Arc<dyn AgentLoopObserver>>,
}

impl ProductionAgentLoop {
    pub(crate) fn native(
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
                #[cfg(test)]
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

fn invalid_contract(code: &'static str) -> BtccError {
    BtccError::new(code, code)
}
