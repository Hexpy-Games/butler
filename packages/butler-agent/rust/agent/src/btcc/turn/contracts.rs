use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::btcc::{
    AcceptedWorkResult, AlreadyDeliveredOutcome, ExecutionOutcome, FinalArtifact, ModelIdentity,
    ProgressDestination, RuntimeFailure, TurnRequest, WorkStatus,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TurnSemanticState {
    Admitted,
    DeliveryCommitted,
    Delivered,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedTurn {
    pub preparation_id: String,
    pub request: TurnRequest,
    pub command: Value,
    pub admission_input_hash: String,
    pub is_fresh: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnRecord {
    pub turn_id: String,
    pub session_id: String,
    pub inbox_id: String,
    pub trigger_key: String,
    pub original_message_id: String,
    pub original_message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wake_identity: Option<WakeIdentity>,
    pub model_selection: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_route: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation_budget: Option<Value>,
    pub context: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_destination: Option<ProgressDestination>,
    pub semantic_state: TurnSemanticState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suspension: Option<SuspensionReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_continuation: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<TurnCheckpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<ExecutionRoute>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_payload: Option<FinalPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_outbox: Option<DeliveryOutbox>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_assistant_message_id: Option<String>,
    pub revision: u64,
    pub execution_fence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_disposition: Option<FinalDisposition>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WakeIdentity {
    pub trigger_id: String,
    pub source_turn_id: String,
    pub authorization_ref: String,
    pub result_scope_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnCheckpoint {
    pub checkpoint_id: String,
    pub checkpoint_revision: u64,
    pub semantic_state: TurnSemanticState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SuspensionReason {
    AuthorityPending,
    WaitingForWorker,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FinalDisposition {
    Completed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ContentRef {
    pub id: String,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeliveryOutbox {
    pub outbox_id: String,
    pub final_payload_ref: ContentRef,
    pub expected_message_id: String,
    pub content: String,
    pub status: DeliveryStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FinalPayload {
    #[serde(rename = "ref")]
    pub reference: ContentRef,
    pub turn_id: String,
    pub route: ExecutionRoute,
    pub disposition: FinalDisposition,
    pub content: String,
    pub content_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_status: Option<WorkStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_work_result: Option<AcceptedWorkResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_failure: Option<RuntimeFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_outcome: Option<ExecutionOutcome>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<FinalArtifact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_files: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_identity: Option<ModelIdentity>,
    #[serde(flatten)]
    pub extensions: serde_json::Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeliveryStatus {
    Pending,
    Inserted,
    Observed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StateExecutionClaim {
    pub claim_id: String,
    pub turn_id: String,
    pub turn_revision: u64,
    pub semantic_state: TurnSemanticState,
    pub checkpoint_id: String,
    pub checkpoint_revision: u64,
    pub execution_fence: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelRouteWrite {
    pub turn_id: String,
    pub expected_revision: u64,
    pub execution_fence: u64,
    pub claim_id: String,
    pub route: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelRouteEventWrite {
    pub binding: ModelRouteWrite,
    pub event: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ModelRoundKey {
    pub turn_id: String,
    pub round_id: String,
    pub route_digest: String,
    pub candidate_index: u32,
    pub model_ref: String,
    pub checkpoint_id: Option<String>,
    pub checkpoint_revision: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelRoundAcceptanceWrite {
    pub binding: ModelRouteWrite,
    pub key: ModelRoundKey,
    pub transport_attempt: u32,
    pub result: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ContinuationBudgetTransition {
    pub binding: ModelRouteWrite,
    pub event: Value,
    pub now_ms: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AgentLoopResult {
    pub route: ExecutionRoute,
    pub content: String,
    pub terminal_outcome: Option<TerminalOutcome>,
    pub suspension: Option<SuspensionReason>,
    pub authority_continuation: Option<Value>,
    pub work_status: Option<WorkStatus>,
    pub accepted_work_result: Option<AcceptedWorkResult>,
    pub runtime_failure: Option<RuntimeFailure>,
    pub artifacts: Vec<FinalArtifact>,
    pub changed_files: Vec<Value>,
    pub plan: Option<Value>,
    pub model_identity: Option<ModelIdentity>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TerminalOutcome {
    NoVisible,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExecutionRoute {
    Direct,
    Assisted,
    Managed,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum TurnTransition {
    Suspend {
        reason: SuspensionReason,
        authority_continuation: Option<Value>,
    },
    AcceptFinal {
        route: ExecutionRoute,
        payload: Box<FinalPayload>,
        outbox: Box<DeliveryOutbox>,
    },
    ObserveDelivery {
        assistant_message_id: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum StopPersistenceOutcome {
    Cancelled,
    AlreadyCancelled,
    AlreadyFinalizing,
    AlreadyDelivered(Box<AlreadyDeliveredOutcome>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProgressEvent {
    Started,
    StateChanged {
        semantic_state: TurnSemanticState,
        turn_revision: u64,
    },
    Cancelled,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProgressWrite {
    pub session_id: String,
    pub turn_id: String,
    pub destination: ProgressDestination,
    pub event: crate::btcc::RuntimeTurnEventInput,
}
