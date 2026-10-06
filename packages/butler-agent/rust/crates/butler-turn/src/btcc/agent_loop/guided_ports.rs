use std::{future::Future, pin::Pin, sync::Arc};

#[cfg(any(test, feature = "test-support"))]
use crate::btcc::StateExecutionClaim;
use crate::btcc::{
    AcceptedWorkResult, AgentLoopProgress, FinalArtifact, PortFuture, TurnRecord, WorkStatus,
};

use super::continuation::GuidedPresentation;
use super::contracts::{
    BatchDisposition, CandidateDisposition, ContextProjectionInput, LoopPhase, ModelRoundMessage,
    ModelRoundTool, ModelRoundToolCall, SteeringObservation, TextCallDisposition, ToolOutcome,
    ToolResult, ToolSurface,
};
use super::ports::{ContextProjectionFuture, ToolExecutionError};

/// What every guided port call borrows from the running turn.
#[derive(Clone, Copy)]
pub struct GuidedInvocation<'a> {
    pub turn: &'a TurnRecord,
    #[cfg(any(test, feature = "test-support"))]
    pub claim: &'a StateExecutionClaim,
    #[cfg(any(test, feature = "test-support"))]
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
            #[cfg(any(test, feature = "test-support"))]
            claim: input.claim,
            #[cfg(any(test, feature = "test-support"))]
            recovery_attempt: input.recovery_attempt,
            progress: input.progress,
            cancellation: &input.cancellation,
            model_execution: input.model_execution,
            operation_results: input.operation_results,
        }
    }
}

/// Immutable hook scope bound by the host before model execution.
pub struct GuidedHookBinding {
    /// Process-owned dispatcher.
    pub port: Arc<dyn butler_core::hooks::HookPort>,
    /// Bound project root, otherwise null.
    pub project_dir: Option<String>,
    /// Project root or user home.
    pub cwd: String,
    /// Effective permission mode.
    pub access_mode: String,
    /// Delegation parent, if this is a child turn.
    pub parent_session_id: Option<String>,
}

/// The ports a guided policy is composed of.
pub struct GuidedPolicyDependencies {
    /// Optional user lifecycle dispatcher and immutable turn scope.
    pub hooks: Option<GuidedHookBinding>,
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

/// Renders the guided prompt of a turn.
pub trait PromptPort: Send + Sync {
    /// Renders the prompt, instructions, tools and request options.
    fn render<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, RenderedGuidedPrompt>;
}

pub use super::guided_types::{
    FinalSynthesis, PromptImages, RenderedGuidedPrompt, RoundRequestOptions,
};

/// Authority presentation of a guided turn.
pub trait AuthorityPort: Send + Sync {
    /// The activity presentation to persist when the turn suspends for authority.
    fn presentation<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Option<GuidedPresentation>>;
}

/// Steering and context projection of a guided turn.
pub trait ContextPort: Send + Sync {
    /// User messages that arrived since the last round.
    fn steering<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Vec<SteeringObservation>>;

    /// Starts the turn's context projection under its continuation budget.
    fn begin_turn<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        budget: Option<Arc<dyn crate::btcc::TurnContinuationBudgetPort>>,
    ) -> PortFuture<'a, Box<dyn TurnContextProjection + 'a>>;
}

/// Observes user messages that arrive while a turn runs.
pub trait TurnSteeringPort: Send + Sync {
    /// New steering messages since the last observation.
    fn observe<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Vec<SteeringObservation>>;
}

/// Projects each round's messages within the turn's context budget.
pub trait TurnContextProjection: Send + Sync {
    /// The projection of one round.
    fn project<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        input: ContextProjectionInput<'a>,
    ) -> ContextProjectionFuture<'a>;
}

/// Resolves and executes the tools of a guided turn.
pub trait ToolPort: Send + Sync {
    /// Underlying native/MCP identity behind a progressive call.
    fn hook_tool_name<'a>(&self, call: &'a ModelRoundToolCall) -> std::borrow::Cow<'a, str> {
        std::borrow::Cow::Borrowed(&call.name)
    }
    /// Full arguments of that underlying call.
    fn hook_tool_input<'a>(
        &self,
        call: &'a ModelRoundToolCall,
    ) -> &'a serde_json::Map<String, serde_json::Value> {
        &call.arguments
    }

    /// The tools offered for the next round; the final-report phase offers none.
    fn surface<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        fallback: &'a [ModelRoundTool],
        phase: LoopPhase,
    ) -> PortFuture<'a, ToolSurface>;

    /// Executes a tool call and returns its encoded output.
    fn execute<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        contract_version: Option<u8>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<butler_core::json::JsonDocument, ToolExecutionError>>
                + Send
                + 'a,
        >,
    >;

    /// Journals a call the user's authority decision kept from running.
    fn record_unexecuted<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        result: &'a ToolResult,
    ) -> PortFuture<'a, ()>;

    /// The journal call id of a provider tool call, if journaled.
    fn operation_result_call_id(&self, provider_call_id: &str) -> Option<String>;

    /// The transcript message of a tool result.
    fn result_message<'a>(
        &'a self,
        turn: &'a TurnRecord,
        result: &'a ToolResult,
        references: &'a super::operation_result_replay::OperationResultMessageReferences,
    ) -> PortFuture<'a, ModelRoundMessage>;
}

/// The guided turn journal: text tool calls, synthesis, candidates and closeout.
pub trait JournalPort: Send + Sync {
    /// Journals tool calls the model wrote as text and decides the error.
    fn handle_text_tool_calls<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        names: &'a [String],
        calls: &'a [ModelRoundToolCall],
        text: &'a str,
        iteration: u32,
    ) -> PortFuture<'a, TextCallDisposition>;

    /// A final answer synthesized from the transcript.
    fn synthesize_final<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        messages: &'a [ModelRoundMessage],
        iteration: u32,
    ) -> PortFuture<'a, String>;

    /// Whether the journal accepts the model's text as the final answer after tool use.
    fn accept_tool_candidate<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
    ) -> PortFuture<'a, bool>;

    /// Journals the assistant text that precedes a tool batch.
    fn assistant_before_tools<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
        calls: &'a [ModelRoundToolCall],
        iteration: u32,
    ) -> PortFuture<'a, ()>;

    /// Whether a tool result suspends the turn.
    fn outcome<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        result: &'a ToolResult,
    ) -> PortFuture<'a, Option<ToolOutcome>>;

    /// The artifacts and changes the turn produced.
    fn closeout<'a>(&'a self, invocation: GuidedInvocation<'a>) -> PortFuture<'a, JournalCloseout>;
}

/// What the journal contributes to the final payload.
pub struct JournalCloseout {
    pub artifacts: Vec<FinalArtifact>,
    pub changed_files: Vec<crate::btcc::ChangedFileSummary>,
}

/// Durable Work of a guided turn.
pub trait WorkPort: Send + Sync {
    /// What the loop does after a tool batch, from the Work's state.
    fn after_batch<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        calls: &'a [ModelRoundToolCall],
        results: &'a [ToolResult],
        iteration: u32,
    ) -> PortFuture<'a, BatchDisposition>;

    /// Reviews a final-answer candidate against the Work.
    fn review_candidate<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
        iteration: u32,
    ) -> PortFuture<'a, CandidateDisposition>;

    /// The final content reconciled with the Work's final state.
    fn reconcile<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        content: &'a str,
    ) -> PortFuture<'a, String>;

    /// The Work status the turn ends with.
    fn final_state<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, WorkFinalState>;
    /// The accepted Work result, if the Work was accepted.
    fn accepted_result<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Option<AcceptedWorkResult>>;
}

/// The Work state a turn ends with.
pub struct WorkFinalState {
    pub status: Option<WorkStatus>,
    pub has_work: bool,
}
