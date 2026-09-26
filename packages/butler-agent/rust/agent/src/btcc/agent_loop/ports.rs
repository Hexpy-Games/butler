use std::{future::Future, pin::Pin};

use serde_json::Value;

use crate::btcc::{BtccError, PortFuture, RuntimeFailure, TurnRecord};

use super::continuation::GuidedPresentation;
use super::contracts::{
    AgentLoopEvent, BatchDisposition, CandidateDisposition, CloseoutInput, ContextProjection,
    ContextProjectionInput, GuidedCloseout, ModelRoundRequest, ModelRoundResult, ModelRoundTool,
    ModelRoundToolCall, PreparedPolicy, SteeringObservation, TextCallDisposition, ToolOutcome,
    ToolResult,
};
use super::guided_ports::GuidedInvocation;
use super::guided_ports::TurnContextProjection;

#[derive(Clone, Debug)]
pub(crate) enum ModelRoundError {
    Provider(Box<crate::btcc::model_route::ProviderRequestError>),
    RequestAdmission(Box<crate::btcc::ModelRequestAdmissionError>),
    /// Source exceptions from invocation callbacks and synchronous metric I/O.
    /// These are not provider transport failures and must not enter its retry loop.
    InvocationFailure {
        code: Option<String>,
        message: String,
    },
    StablePrefix(String),
    ImageAdmission {
        code: String,
        reason: String,
    },
    Recovered {
        failure_code: String,
        disposition: String,
    },
    DispatchLimit,
    Cancelled,
    Operational(RuntimeFailure),
    Integrity(BtccError),
}

#[derive(Clone, Debug)]
pub(crate) enum ToolExecutionError {
    Integrity(BtccError),
}

#[derive(Clone, Debug)]
pub(crate) enum ContextProjectionError {
    Model(ModelRoundError),
    Contract(BtccError),
}

pub(crate) type ContextProjectionFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ContextProjection, ContextProjectionError>> + Send + 'a>>;

pub(crate) trait ModelRoundPort: Send + Sync {
    fn context_sizing<'a>(
        &'a self,
        _request: crate::btcc::model_route::ContextSizingRequest<'a>,
    ) -> Result<Option<crate::btcc::model_route::ContextSizing<'a>>, ModelRoundError> {
        Ok(None)
    }

    fn initial_request_bytes(
        &self,
        _prompt: &str,
        _instructions: &str,
        _butler_data: Option<&str>,
    ) -> Result<Option<usize>, ModelRoundError> {
        Ok(None)
    }

    fn stateless_message_bytes(
        &self,
        _messages: &[super::contracts::ModelRoundMessage],
        _butler_data: Option<&str>,
    ) -> Result<Option<usize>, ModelRoundError> {
        Ok(None)
    }

    fn run_round<'a>(
        &'a self,
        request: ModelRoundRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<ModelRoundResult, ModelRoundError>> + Send + 'a>>;
}

pub(crate) type ModelRoundObservationFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

/// Per-execution observer for the last model request, response, and terminal failure.
/// Implementations are diagnostic-only and must not return errors into model execution.
pub(crate) trait ModelRoundObserver: Send + Sync {
    fn request<'a>(
        &'a self,
        _request: &'a super::contracts::ModelRoundRequest<'_>,
    ) -> ModelRoundObservationFuture<'a> {
        Box::pin(async {})
    }

    fn response<'a>(
        &'a self,
        _response: &'a super::contracts::ModelRoundResult,
    ) -> ModelRoundObservationFuture<'a> {
        Box::pin(async {})
    }

    fn failure<'a>(&'a self, _error: &'a ModelRoundError) -> ModelRoundObservationFuture<'a> {
        Box::pin(async {})
    }
}

#[cfg(test)]
pub(crate) struct NoopModelRoundObserver;

#[cfg(test)]
impl ModelRoundObserver for NoopModelRoundObserver {}

pub(crate) trait VerifiedImagePayloadPort: Send + Sync {
    fn read<'a>(&'a self, reference: &'a Value) -> PortFuture<'a, Vec<u8>>;
}

/// Turn-budget authority for the exact serialized provider request body.
/// The implementation captures the admitted round/digest; the provider only
/// reports the byte count, as in boundedContinuation.admitProviderBody.
pub(crate) trait ProviderBodyAdmissionPort: Send + Sync {
    fn admit(
        &self,
        serialized_bytes: usize,
    ) -> Pin<Box<dyn Future<Output = Result<(), ModelRoundError>> + Send + '_>>;
}

pub(crate) trait ProviderStreamObserver: Send + Sync {
    fn event(&self, event: &Value);
}

pub(crate) trait ProviderIdentityObserver: Send + Sync {
    fn identity(&self, identity: &super::contracts::ProviderIdentity);
}

pub(crate) trait GuidedPolicyPort: Send + Sync {
    fn prepare<'a>(&'a self, invocation: GuidedInvocation<'a>) -> PortFuture<'a, PreparedPolicy>;

    fn before_model_round<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Vec<SteeringObservation>>;

    fn resolve_tools<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        fallback: &'a [ModelRoundTool],
        final_report: bool,
    ) -> PortFuture<'a, (Vec<ModelRoundTool>, Option<String>)>;

    fn begin_context<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        budget: Option<std::sync::Arc<dyn crate::btcc::TurnContinuationBudgetPort>>,
    ) -> PortFuture<'a, Box<dyn TurnContextProjection + 'a>>;

    fn prepare_context<'a>(
        &'a self,
        context: &'a dyn TurnContextProjection,
        invocation: GuidedInvocation<'a>,
        input: ContextProjectionInput<'a>,
    ) -> ContextProjectionFuture<'a>;

    fn execute_tool<'a>(
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

    fn assistant_before_tools<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
        calls: &'a [ModelRoundToolCall],
        iteration: u32,
    ) -> PortFuture<'a, ()>;

    fn after_tool_batch<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        calls: &'a [ModelRoundToolCall],
        results: &'a [ToolResult],
        iteration: u32,
    ) -> PortFuture<'a, BatchDisposition>;

    fn outcome_from_tool_result<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        result: &'a ToolResult,
    ) -> PortFuture<'a, Option<ToolOutcome>>;

    fn review_final_candidate<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
        iteration: u32,
    ) -> PortFuture<'a, CandidateDisposition>;

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
        messages: &'a [super::contracts::ModelRoundMessage],
        iteration: u32,
    ) -> PortFuture<'a, String>;

    fn accept_tool_candidate<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
    ) -> PortFuture<'a, bool>;

    fn operation_result_call_id(&self, provider_call_id: &str) -> Option<String>;

    fn tool_result_message<'a>(
        &'a self,
        turn: &'a TurnRecord,
        result: &'a ToolResult,
        references: &'a super::operation_result_replay::OperationResultMessageReferences,
    ) -> PortFuture<'a, super::contracts::ModelRoundMessage>;

    fn presentation<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Option<GuidedPresentation>>;

    fn closeout<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        input: CloseoutInput<'a>,
    ) -> PortFuture<'a, GuidedCloseout>;
}

pub(crate) trait AgentLoopObserver: Send + Sync {
    fn event(&self, event: &AgentLoopEvent);
}

pub(super) fn propagated(error: BtccError) -> crate::btcc::AgentLoopError {
    crate::btcc::AgentLoopError::Propagate(error)
}

pub(super) fn runtime(failure: RuntimeFailure) -> crate::btcc::AgentLoopError {
    crate::btcc::AgentLoopError::Runtime(failure)
}
