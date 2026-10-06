use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::btcc::{
    AcceptedWorkResult, BtccError, FinalArtifact, ModelIdentity, ReasoningEffort, RuntimeFailure,
    TurnRecord, WorkStatus,
};

use super::continuation::AuthorityLoopContinuation;
use super::guided_types::{FinalSynthesis, PromptImages, RoundRequestOptions};
use crate::btcc::BtccCode;

mod context;
pub use context::*;

/// The model admitted for a turn, as persisted in `TurnRecord::model_selection`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmittedModelSelection {
    pub provider: String,
    pub model: String,
    pub reasoning_effort: ReasoningEffort,
    /// Provider-specific execution controls (passthrough JSON hashed into `controls_hash`).
    #[serde(default)]
    pub controls: Map<String, Value>,
    pub controls_hash: String,
    pub context_window_tokens: Option<f64>,
    #[serde(flatten)]
    // Passthrough: unknown fields kept for forward compatibility.
    pub extensions: Map<String, Value>,
}

/// Where a turn records its Work: the shared ledger, a local store, or nowhere.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackingMode {
    Ledger,
    Local,
    None,
}

/// The admitted execution policy of a turn: role, access and tool requirements.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionPolicy {
    pub role: String,
    pub access_mode: crate::btcc::AccessMode,
    pub tracking_mode: TrackingMode,
    #[serde(default)]
    pub required_native_tool_profiles: Vec<String>,
    #[serde(default)]
    pub required_native_tools: Vec<String>,
    pub workspace_path: String,
    pub project_id: Option<String>,
    /// Unknown fields, including the delegated `subsession` (read through
    /// the guided execution policy), kept for newer writers.
    #[serde(flatten)]
    // Passthrough: unknown fields kept for forward compatibility.
    pub extensions: Map<String, Value>,
}

/// The admitted Butler context of a turn, as persisted in `TurnRecord::context`.
///
/// Branch seeds, message content, references, sources, attachments and image
/// admission are passthrough JSON owned by the context assembler and image
/// admission; this contract only carries them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButlerContext {
    // Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
    pub branch_seed: Option<Value>,
    pub app_session_id: Option<String>,
    // Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
    pub message_content: Option<Value>,
    #[serde(default)]
    // Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
    pub session_references: Vec<Value>,
    #[serde(default)]
    // Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
    pub project_sources: Vec<Value>,
    pub user_ref: String,
    pub project_ref: Option<String>,
    #[serde(default)]
    pub profile_refs: Vec<String>,
    #[serde(default)]
    pub recent_feedback_refs: Vec<String>,
    #[serde(default)]
    pub mandatory_hot_cache_refs: Vec<String>,
    #[serde(default)]
    pub optional_hot_cache_refs: Vec<String>,
    #[serde(default)]
    pub baseline_observation_scope_refs: Vec<String>,
    pub empty_response_policy: Option<EmptyResponsePolicy>,
    pub execution_policy: Option<ExecutionPolicy>,
    #[serde(default)]
    // Passthrough: image admission and attachment documents owned by butler-runtime.
    pub attachments: Vec<Value>,
    // Passthrough: image admission and attachment documents owned by butler-runtime.
    pub image_admission: Option<Value>,
    pub authority_request_ref: Option<String>,
    pub authority_client_message_id: Option<String>,
    pub plan_id: Option<String>,
    #[serde(flatten)]
    // Passthrough: unknown fields kept for forward compatibility.
    pub extensions: Map<String, Value>,
}

/// What a turn does when the model ends without visible content.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmptyResponsePolicy {
    SafeFallback,
    TypedTerminal,
}

/// The typed view of a turn record the agent loop runs on.
pub struct SemanticTurn {
    pub model: AdmittedModelSelection,
    pub context: ButlerContext,
    pub authority: Option<AuthorityLoopContinuation>,
}

impl SemanticTurn {
    /// Decodes the persisted model selection, context and authority continuation.
    pub fn parse(turn: &TurnRecord) -> Result<Self, BtccError> {
        let model = turn.model_selection.clone();
        let context = ButlerContext::deserialize(&turn.context).map_err(|source| {
            super::invalid_contract(BtccCode::InvalidButlerContext).with_source(source)
        })?;
        let authority = turn.authority_continuation.as_deref().cloned();
        Ok(Self {
            model,
            context,
            authority,
        })
    }
}

/// The author of a model-round message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelRoundRole {
    System,
    User,
    Assistant,
    Tool,
}

/// A tool call the model requested.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoundToolCall {
    pub id: String,
    pub name: String,
    /// Tool arguments are passthrough JSON validated by the tool that runs them.
    pub arguments: Map<String, Value>,
    pub raw_arguments: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<ToolCallOrigin>,
}

/// Whether a tool call came from the provider's native tool channel or was parsed from text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallOrigin {
    Native,
    Text,
}

/// One transcript message of the loop, persisted inside authority continuations.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoundMessage {
    #[serde(skip)]
    pub facts: super::message_facts::MessageFacts,
    pub role: ModelRoundRole,
    pub content: Arc<str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ModelRoundToolCall>>,
    /// Admitted image attachments (provider passthrough JSON).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_attachments: Vec<Value>,
    /// Provider-owned raw data echoed back on the next request (passthrough JSON).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_segment_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_result_reference:
        Option<super::operation_result_replay::OperationResultReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_result_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation_item_id: Option<String>,
}

impl ModelRoundMessage {
    /// A user message, optionally tagged with the request segment it belongs to.
    pub fn user(content: String, segment: Option<String>) -> Self {
        Self {
            facts: Default::default(),
            role: ModelRoundRole::User,
            content: content.into(),
            tool_call_id: None,
            name: None,
            tool_calls: None,
            image_attachments: Vec::new(),
            provider_data: None,
            request_segment_kind: segment,
            operation_result_reference: None,
            operation_result_call_id: None,
            continuation_item_id: None,
        }
    }
}

/// A tool offered to the model.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoundTool {
    pub name: String,
    pub description: String,
    /// The tool's JSON Schema, forwarded to the provider unchanged.
    // Passthrough: tool arguments/results/schemas, shaped by each tool.
    pub parameters: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub concurrency_safe: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_contract_version: Option<u8>,
}

/// One provider request of the loop, borrowed from the loop state for the round.
///
/// Attachments, image carrier/capability/manifests, route context and provider
/// continuations are provider passthrough JSON owned by the provider serializer.
pub struct ModelRoundRequest<'a> {
    pub max_output_tokens: Option<f64>,
    pub round_id: Option<&'a str>,
    pub model: &'a str,
    pub messages: &'a [ModelRoundMessage],
    pub instructions: Option<&'a str>,
    pub tools: &'a [ModelRoundTool],
    pub tool_surface_digest: Option<&'a str>,
    pub tool_choice: Option<ToolChoice>,
    pub reasoning_effort: &'a ReasoningEffort,
    pub cancellation: CancellationToken,
    // Passthrough: image admission and attachment documents owned by butler-runtime.
    pub attachments: &'a [Value],
    // Passthrough: image admission and attachment documents owned by butler-runtime.
    pub image_carrier: Option<&'a Value>,
    // Passthrough: image admission and attachment documents owned by butler-runtime.
    pub image_capability: Option<&'a Value>,
    // Passthrough: image admission and attachment documents owned by butler-runtime.
    pub image_manifests: &'a [Value],
    pub verified_image_payload: Option<&'a dyn super::ports::VerifiedImagePayloadPort>,
    pub butler_data: Option<&'a str>,
    pub usage_attribution: Option<&'a UsageAttribution>,
    pub cache_scope: Option<&'a str>,
    // Passthrough: provider payload, opaque to BTCC.
    pub stable_provider_cache_prefix: Option<&'a Value>,
    // Passthrough: provider payload, opaque to BTCC.
    pub route_context: Option<&'a Value>,
    pub provider_retry_attempts: Option<f64>,
    pub route_transport_attempt_ordinal: Option<u32>,
    // Passthrough: provider payload, opaque to BTCC.
    pub continuation: Option<&'a Value>,
    // Passthrough: provider payload, opaque to BTCC.
    pub bounded_continuation: Option<&'a Value>,
    pub provider_body_admission: Option<&'a dyn super::ports::ProviderBodyAdmissionPort>,
    pub stream_observer: Option<&'a dyn super::ports::ProviderStreamObserver>,
    pub identity_observer: Option<&'a dyn super::ports::ProviderIdentityObserver>,
}

/// Which turn, phase and round a provider usage record is billed to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAttribution {
    /// Runtime-owned request classification; absent in older durable rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_kind: Option<String>,
    pub turn_id: String,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round_index: Option<u32>,
}

/// Whether the model may answer without a tool call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolChoice {
    Auto,
    Required,
}

/// The accepted outcome of one provider round.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoundResult {
    /// The provider explicitly marked visible text as progress rather than a final answer.
    /// Providers without such a distinction leave this false; Work review still applies.
    #[serde(default)]
    pub nonfinal: bool,
    pub text: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<ModelRoundToolCall>,
    /// Tool names the model wrote as text instead of calling natively.
    #[serde(default)]
    pub text_tool_call_names: Vec<String>,
    pub assistant_message: Option<ModelRoundMessage>,
    /// Provider continuation handle for the next request (passthrough JSON).
    pub continuation: Option<Value>,
    /// Provider usage report (passthrough JSON).
    pub usage: Option<Value>,
    pub provider_identity: Option<ProviderIdentity>,
    /// Raw provider response data (passthrough JSON).
    pub raw: Option<Value>,
    pub accepted_checkpoint: Option<AcceptedCheckpoint>,
}

/// The route checkpoint that accepted a round: which candidate and transport attempt answered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedCheckpoint {
    pub round_id: String,
    pub candidate_index: u32,
    pub transport_attempt: u32,
    pub model_ref: String,
}

/// The model a provider reported serving, next to the one that was configured.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderIdentity {
    pub provider: String,
    pub configured_model: String,
    pub reported_model: String,
}

/// The recorded result of one tool call, persisted inside authority continuations.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub tool_call_id: String,
    pub name: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ToolError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<butler_core::json::JsonDocument>,
}

/// Why a tool call failed, in the model-facing error shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

/// A tool result that ends the loop early.
#[derive(Clone, Debug, PartialEq)]
pub enum ToolOutcome {
    Suspend(crate::btcc::SuspensionReason),
}

/// What the loop does after a tool batch settles.
#[derive(Clone, Debug, PartialEq)]
pub enum BatchDisposition {
    /// Ask the model for its next round.
    Continue,
    /// Execution is settled: ask the model for the final report without tools.
    FinalReport,
    /// Suspend the turn until a worker finishes.
    Wait,
}

/// The Work review of a final-answer candidate.
#[derive(Clone, Debug, PartialEq)]
pub enum CandidateDisposition {
    /// Accept the answer, optionally replacing its content.
    Accepted(Option<String>),
    /// Reject it and send this observation to the model.
    Continue(String),
}

/// Diagnostic events the loop reports to its observer, in execution order.
#[derive(Clone, Debug, PartialEq)]
pub enum AgentLoopEvent {
    ModelCall {
        iteration: u32,
    },
    ModelResponse {
        iteration: u32,
        text: Option<String>,
    },
    ModelFailure {
        iteration: u32,
        code: String,
    },
    ToolCall {
        iteration: u32,
        call: ModelRoundToolCall,
    },
    ToolResult {
        iteration: u32,
        result: ToolResult,
    },
}

/// The policy's preparation of a turn: the rendered prompt plus the decision
/// and provider ports bound for this execution.
pub(crate) struct PreparedPolicy {
    pub prompt: String,
    pub instructions: Option<String>,
    pub tools: Vec<ModelRoundTool>,
    pub tool_choice: Option<ToolChoice>,
    pub resumed_tool_call: Option<ModelRoundToolCall>,
    pub authority_decision: Option<AuthorityDecision>,
    pub images: PromptImages,
    pub request: RoundRequestOptions,
    pub ports: ProviderRoundPorts,
    pub final_synthesis: FinalSynthesis,
}

/// Provider-side ports a round request borrows: image payload reads and stream/identity observers.
#[derive(Clone, Default)]
pub(crate) struct ProviderRoundPorts {
    pub verified_image_payload: Option<Arc<dyn super::ports::VerifiedImagePayloadPort>>,
    pub stream_observer: Option<Arc<dyn super::ports::ProviderStreamObserver>>,
    pub identity_observer: Option<Arc<dyn super::ports::ProviderIdentityObserver>>,
}

/// Whether the loop is still working with tools or has settled and only asks
/// the model for its final report (no tools, no forced tool choice).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LoopPhase {
    #[default]
    Working,
    FinalReport,
}

/// The tools offered for one round, with the digest of that surface when the
/// tool port publishes one for provider caching.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolSurface {
    pub tools: Vec<ModelRoundTool>,
    pub digest: Option<String>,
}
