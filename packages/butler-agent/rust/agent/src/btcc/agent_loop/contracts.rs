use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::btcc::{
    AcceptedWorkResult, BtccError, FinalArtifact, ModelIdentity, ReasoningEffort, RuntimeFailure,
    TurnRecord, WorkStatus,
};

use super::continuation::AuthorityLoopContinuation;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdmittedModelSelection {
    pub provider: String,
    pub model: String,
    pub reasoning_effort: ReasoningEffort,
    #[serde(default)]
    pub controls: Map<String, Value>,
    pub controls_hash: String,
    pub context_window_tokens: Option<f64>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TrackingMode {
    Ledger,
    Local,
    None,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecutionPolicy {
    pub role: String,
    pub access_mode: crate::btcc::AccessMode,
    pub tracking_mode: TrackingMode,
    #[serde(default)]
    pub required_native_tool_profiles: Vec<String>,
    #[serde(default)]
    pub required_native_tools: Vec<String>,
    pub workspace_path: String,
    pub project_id: Option<String>,
    pub subsession: Option<Value>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ButlerContext {
    pub branch_seed: Option<Value>,
    pub app_session_id: Option<String>,
    pub message_content: Option<Value>,
    #[serde(default)]
    pub session_references: Vec<Value>,
    #[serde(default)]
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
    pub attachments: Vec<Value>,
    pub image_admission: Option<Value>,
    pub authority_request_ref: Option<String>,
    pub authority_client_message_id: Option<String>,
    pub plan_id: Option<String>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EmptyResponsePolicy {
    SafeFallback,
    TypedTerminal,
}

pub(crate) struct SemanticTurn {
    pub model: AdmittedModelSelection,
    pub context: ButlerContext,
    pub authority: Option<AuthorityLoopContinuation>,
}

impl SemanticTurn {
    pub(crate) fn parse(turn: &TurnRecord) -> Result<Self, BtccError> {
        let model = AdmittedModelSelection::deserialize(&turn.model_selection)
            .map_err(|_| super::invalid_contract("invalid_admitted_model_selection"))?;
        let context = ButlerContext::deserialize(&turn.context)
            .map_err(|_| super::invalid_contract("invalid_butler_context"))?;
        let authority = turn
            .authority_continuation
            .as_ref()
            .map(AuthorityLoopContinuation::deserialize)
            .transpose()
            .map_err(|_| super::invalid_contract("invalid_authority_continuation"))?;
        Ok(Self {
            model,
            context,
            authority,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ModelRoundRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelRoundToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Map<String, Value>,
    pub raw_arguments: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<ToolCallOrigin>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolCallOrigin {
    Native,
    Text,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelRoundMessage {
    pub role: ModelRoundRole,
    pub content: Arc<str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ModelRoundToolCall>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_attachments: Vec<Value>,
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
    pub(super) fn user(content: String, segment: Option<String>) -> Self {
        Self {
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelRoundTool {
    pub name: String,
    pub description: String,
    pub parameters: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub concurrency_safe: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_contract_version: Option<u8>,
}

pub(crate) struct ModelRoundRequest<'a> {
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
    pub attachments: &'a [Value],
    pub image_carrier: Option<&'a Value>,
    pub image_capability: Option<&'a Value>,
    pub image_manifests: &'a [Value],
    pub verified_image_payload: Option<&'a dyn super::ports::VerifiedImagePayloadPort>,
    pub butler_data: Option<&'a str>,
    pub usage_attribution: Option<&'a UsageAttribution>,
    pub cache_scope: Option<&'a str>,
    pub stable_provider_cache_prefix: Option<&'a Value>,
    pub route_context: Option<&'a Value>,
    pub provider_retry_attempts: Option<f64>,
    pub route_transport_attempt_ordinal: Option<u32>,
    pub continuation: Option<&'a Value>,
    pub bounded_continuation: Option<&'a Value>,
    pub provider_body_admission: Option<&'a dyn super::ports::ProviderBodyAdmissionPort>,
    pub stream_observer: Option<&'a dyn super::ports::ProviderStreamObserver>,
    pub identity_observer: Option<&'a dyn super::ports::ProviderIdentityObserver>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageAttribution {
    pub turn_id: String,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round_index: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolChoice {
    Auto,
    Required,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelRoundResult {
    pub text: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<ModelRoundToolCall>,
    #[serde(default)]
    pub text_tool_call_names: Vec<String>,
    pub assistant_message: Option<ModelRoundMessage>,
    pub continuation: Option<Value>,
    pub usage: Option<Value>,
    pub provider_identity: Option<ProviderIdentity>,
    pub raw: Option<Value>,
    pub accepted_checkpoint: Option<AcceptedCheckpoint>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcceptedCheckpoint {
    pub round_id: String,
    pub candidate_index: u32,
    pub transport_attempt: u32,
    pub model_ref: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderIdentity {
    pub provider: String,
    pub configured_model: String,
    pub reported_model: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolResult {
    pub tool_call_id: String,
    pub name: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ToolError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<crate::json::JsonDocument>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ToolError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ToolOutcome {
    Suspend(crate::btcc::SuspensionReason),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum BatchDisposition {
    Continue,
    FinalReport,
    Wait,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum CandidateDisposition {
    Accepted(Option<String>),
    Continue(String),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum AgentLoopEvent {
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

pub(crate) struct PreparedPolicy {
    pub prompt: String,
    pub instructions: Option<String>,
    pub tools: Vec<ModelRoundTool>,
    pub tool_choice: Option<ToolChoice>,
    pub route_context: Option<Value>,
    pub authority_decision: Option<AuthorityDecision>,
    pub resumed_tool_call: Option<ModelRoundToolCall>,
    pub max_output_tokens: Option<f64>,
    pub attachments: Vec<Value>,
    pub image_carrier: Option<Value>,
    pub image_capability: Option<Value>,
    pub image_manifests: Vec<Value>,
    pub butler_data: Option<String>,
    pub usage_attribution: Option<UsageAttribution>,
    pub cache_scope: Option<String>,
    pub stable_provider_cache_prefix: Option<Value>,
    pub route_transport_attempt_ordinal: Option<u32>,
    pub verified_image_payload: Option<Arc<dyn super::ports::VerifiedImagePayloadPort>>,
    pub stream_observer: Option<Arc<dyn super::ports::ProviderStreamObserver>>,
    pub identity_observer: Option<Arc<dyn super::ports::ProviderIdentityObserver>>,
    pub synthesize_after_tool_candidate: bool,
    pub synthesize_after_tool_empty: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum AuthorityDecision {
    Allow,
    Deny,
    Modify { input: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BoundedContinuationEnvelope {
    pub schema_version: BoundedEnvelopeV1,
    pub model_facing_bytes: u64,
    pub request_digest: String,
    pub response_item_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_projection: Option<ContextProjectionRebaseIdentity>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum BoundedEnvelopeV1 {
    #[serde(rename = "butler.turn-context-envelope.v1")]
    V1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextProjectionRebaseIdentity {
    pub schema_version: ContextProjectionRebaseV1,
    pub projection_revision: RollingContextV1,
    pub projection_digest: String,
    pub projected_through_ordinal: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ContextProjectionRebaseV1 {
    #[serde(rename = "butler.context-projection-rebase.v1")]
    V1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum RollingContextV1 {
    #[serde(rename = "butler.rolling-context.v1")]
    V1,
}

pub(crate) struct ContextProjectionInput<'a> {
    pub round_id: &'a str,
    pub response_item_id: &'a str,
    pub semantic_messages: &'a [ModelRoundMessage],
    pub transport_messages: &'a [ModelRoundMessage],
    pub model_ref: &'a str,
    pub instructions: Option<&'a str>,
    pub tools: &'a [ModelRoundTool],
    pub tool_choice: Option<ToolChoice>,
    pub attachments: &'a [Value],
    pub butler_data: Option<&'a str>,
    pub max_model_facing_bytes: u64,
}

pub(crate) enum ContextMessages {
    Semantic,
    Transport,
    Owned(Vec<ModelRoundMessage>),
}

pub(crate) struct ContextProjection {
    pub messages: ContextMessages,
    pub bounded_continuation: Option<BoundedContinuationEnvelope>,
    pub provider_body_admission: Option<Box<dyn super::ports::ProviderBodyAdmissionPort>>,
    pub requires_rebase: bool,
    pub recheck_steering_on_rebase: bool,
}

pub(crate) struct CloseoutInput<'a> {
    pub content: &'a str,
    pub suspension: Option<crate::btcc::SuspensionReason>,
}

pub(crate) struct GuidedCloseout {
    pub content: String,
    pub work_status: Option<WorkStatus>,
    pub accepted_work_result: Option<AcceptedWorkResult>,
    pub runtime_failure: Option<RuntimeFailure>,
    pub artifacts: Vec<FinalArtifact>,
    pub changed_files: Vec<Value>,
    pub plan: Option<Value>,
    pub model_identity: Option<ModelIdentity>,
    pub has_final_work: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SteeringObservation {
    pub content: String,
    pub request_segment_kind: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ReplayPreparation {
    pub messages: Option<Vec<ModelRoundMessage>>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum TextCallDisposition {
    Fail(BtccError),
}
