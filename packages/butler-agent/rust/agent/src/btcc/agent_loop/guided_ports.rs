use std::{future::Future, pin::Pin, sync::Arc};

use serde_json::Value;

#[cfg(test)]
use crate::btcc::StateExecutionClaim;
use crate::btcc::{
    AcceptedWorkResult, AgentLoopProgress, FinalArtifact, PortFuture, TurnRecord, WorkStatus,
};

use super::continuation::GuidedPresentation;
use super::contracts::{
    BatchDisposition, CandidateDisposition, ContextProjectionInput, ModelRoundMessage,
    ModelRoundTool, ModelRoundToolCall, SteeringObservation, TextCallDisposition, ToolOutcome,
    ToolResult,
};
use super::ports::{ContextProjectionFuture, ToolExecutionError};

#[derive(Clone, Copy)]
pub(crate) struct GuidedInvocation<'a> {
    pub turn: &'a TurnRecord,
    #[cfg(test)]
    pub claim: &'a StateExecutionClaim,
    #[cfg(test)]
    pub recovery_attempt: u32,
    pub progress: &'a dyn AgentLoopProgress,
    pub cancellation: &'a tokio_util::sync::CancellationToken,
    pub model_execution: &'a dyn crate::btcc::model_route::ModelExecution,
    pub operation_results: Option<&'a dyn super::operation_result_replay::OperationResultRuntime>,
}

impl<'a, 'input: 'a> From<&'a super::driver::Invocation<'input>> for GuidedInvocation<'a> {
    fn from(input: &'a super::driver::Invocation<'input>) -> Self {
        Self {
            turn: input.turn,
            #[cfg(test)]
            claim: input.claim,
            #[cfg(test)]
            recovery_attempt: input.recovery_attempt,
            progress: input.progress,
            cancellation: &input.cancellation,
            model_execution: input.model_execution,
            operation_results: input.operation_results,
        }
    }
}

pub(crate) struct GuidedPolicyDependencies {
    pub prompt: Arc<dyn PromptPort>,
    pub authority: Arc<dyn AuthorityPort>,
    pub context: Arc<dyn ContextPort>,
    pub tools: Arc<dyn ToolPort>,
    pub journal: Arc<dyn JournalPort>,
    pub work: Arc<dyn WorkPort>,
    pub verified_image_payload: Option<Arc<dyn super::ports::VerifiedImagePayloadPort>>,
    pub stream_observer: Option<Arc<dyn super::ports::ProviderStreamObserver>>,
    pub identity_observer: Option<Arc<dyn super::ports::ProviderIdentityObserver>>,
}

pub(crate) trait PromptPort: Send + Sync {
    fn render<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, RenderedGuidedPrompt>;
}

pub(crate) use super::guided_types::RenderedGuidedPrompt;

pub(crate) trait AuthorityPort: Send + Sync {
    fn presentation<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Option<GuidedPresentation>>;
}

pub(crate) trait ContextPort: Send + Sync {
    fn steering<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Vec<SteeringObservation>>;

    fn begin_turn<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        budget: Option<Arc<dyn crate::btcc::TurnContinuationBudgetPort>>,
    ) -> PortFuture<'a, Box<dyn TurnContextProjection + 'a>>;
}

pub(crate) trait TurnSteeringPort: Send + Sync {
    fn observe<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Vec<SteeringObservation>>;
}

pub(crate) trait TurnContextProjection: Send + Sync {
    fn project<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        input: ContextProjectionInput<'a>,
    ) -> ContextProjectionFuture<'a>;
}

pub(crate) trait ToolPort: Send + Sync {
    fn surface<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        fallback: &'a [ModelRoundTool],
        final_report: bool,
    ) -> PortFuture<'a, (Vec<ModelRoundTool>, Option<String>)>;

    fn execute<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        contract_version: Option<u8>,
    ) -> Pin<
        Box<dyn Future<Output = Result<crate::json::JsonDocument, ToolExecutionError>> + Send + 'a>,
    >;

    fn record_unexecuted<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        result: &'a ToolResult,
    ) -> PortFuture<'a, ()>;

    fn operation_result_call_id(&self, provider_call_id: &str) -> Option<String>;

    fn result_message<'a>(
        &'a self,
        turn: &'a TurnRecord,
        result: &'a ToolResult,
        references: &'a super::operation_result_replay::OperationResultMessageReferences,
    ) -> PortFuture<'a, ModelRoundMessage>;
}

pub(crate) trait JournalPort: Send + Sync {
    fn handle_text_tool_calls<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        names: &'a [String],
        calls: &'a [ModelRoundToolCall],
        text: &'a str,
        iteration: u32,
    ) -> PortFuture<'a, TextCallDisposition>;

    fn synthesize_final<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        messages: &'a [ModelRoundMessage],
        iteration: u32,
    ) -> PortFuture<'a, String>;

    fn accept_tool_candidate<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
    ) -> PortFuture<'a, bool>;

    fn assistant_before_tools<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
        calls: &'a [ModelRoundToolCall],
        iteration: u32,
    ) -> PortFuture<'a, ()>;

    fn outcome<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        result: &'a ToolResult,
    ) -> PortFuture<'a, Option<ToolOutcome>>;

    fn closeout<'a>(&'a self, invocation: GuidedInvocation<'a>) -> PortFuture<'a, JournalCloseout>;
}

pub(crate) struct JournalCloseout {
    pub artifacts: Vec<FinalArtifact>,
    pub changed_files: Vec<Value>,
    pub plan: Option<Value>,
}

pub(crate) trait WorkPort: Send + Sync {
    fn after_batch<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        calls: &'a [ModelRoundToolCall],
        results: &'a [ToolResult],
        iteration: u32,
    ) -> PortFuture<'a, BatchDisposition>;

    fn review_candidate<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
        iteration: u32,
    ) -> PortFuture<'a, CandidateDisposition>;

    fn reconcile<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        content: &'a str,
    ) -> PortFuture<'a, String>;

    fn final_state<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, WorkFinalState>;
    fn accepted_result<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Option<AcceptedWorkResult>>;
}

pub(crate) struct WorkFinalState {
    pub status: Option<WorkStatus>,
    pub has_work: bool,
}
