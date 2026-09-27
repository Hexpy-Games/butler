use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::btcc::{
    AcceptedWorkResult, AlreadyDeliveredOutcome, AuthorityLoopContinuation, ChangedFileSummary,
    ExecutionOutcome, FinalArtifact, ModelIdentity, ProgressDestination, RouteState,
    RuntimeFailure, TurnRequest, WorkStatus,
};

/// The durable lifecycle state of a turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnSemanticState {
    Admitted,
    DeliveryCommitted,
    Delivered,
    Cancelled,
}

/// A turn request prepared for admission: its stored command and input hash.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedTurn {
    pub preparation_id: String,
    pub request: TurnRequest,
    pub command: crate::btcc::TurnCommand,
    pub admission_input_hash: String,
    pub is_fresh: bool,
}

/// A stored turn (`btcc_turns`): its admission, route, state and delivery.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRecord {
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
    pub model_route: Option<RouteState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation_budget: Option<Value>,
    pub context: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_destination: Option<ProgressDestination>,
    pub semantic_state: TurnSemanticState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suspension: Option<SuspensionReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_continuation: Option<Box<AuthorityLoopContinuation>>,
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

/// The authorization behind an authorized wake.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeIdentity {
    pub trigger_id: String,
    pub source_turn_id: String,
    pub authorization_ref: String,
    pub result_scope_ref: Option<String>,
}

/// The checkpoint a turn executes from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCheckpoint {
    pub checkpoint_id: String,
    pub checkpoint_revision: u64,
    pub semantic_state: TurnSemanticState,
}

/// Why a turn is suspended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuspensionReason {
    AuthorityPending,
    WaitingForWorker,
}

/// How a turn finally ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinalDisposition {
    Completed,
    Cancelled,
}

/// A content-addressed stored record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentRef {
    pub id: String,
    pub sha256: String,
}

/// The pending delivery of a turn's answer as a canonical message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryOutbox {
    pub outbox_id: String,
    pub final_payload_ref: ContentRef,
    pub expected_message_id: String,
    pub content: String,
    pub status: DeliveryStatus,
}

/// A turn's accepted final answer (persisted and content-addressed).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalPayload {
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
    pub changed_files: Vec<ChangedFileSummary>,
    /// Passthrough: only pre-cutover payloads carry a plan; it is relayed as stored.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_identity: Option<ModelIdentity>,
    #[serde(flatten)]
    pub extensions: serde_json::Map<String, Value>,
}

/// How far an outbox delivery got.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Pending,
    Inserted,
    Observed,
}

/// This runtime's claim to execute one checkpoint of a turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateExecutionClaim {
    pub claim_id: String,
    pub turn_id: String,
    pub turn_revision: u64,
    pub semantic_state: TurnSemanticState,
    pub checkpoint_id: String,
    pub checkpoint_revision: u64,
    pub execution_fence: u64,
}

/// The claim-checked binding under which model-route state is written.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelRouteWrite {
    pub turn_id: String,
    pub expected_revision: u64,
    pub execution_fence: u64,
    pub claim_id: String,
    /// The route state to persist with the write, if any.
    pub route: Option<RouteState>,
}

/// A model-route event recorded under the turn's claim; `binding.route`
/// replaces the persisted route state when present.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelRouteEventWrite {
    pub binding: ModelRouteWrite,
    pub event: ModelRouteEvent,
}

/// The kind of a model-route event; the strings are persisted in
/// `btcc_model_route_events.event_type` and in event ids.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelRouteEventKind {
    AttemptStarted,
    AttemptFailed,
    AttemptSucceeded,
    AttemptAbandonedAfterRestart,
    FallbackSelected,
}

impl ModelRouteEventKind {
    /// The persisted event type.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AttemptStarted => "model.attempt.started",
            Self::AttemptFailed => "model.attempt.failed",
            Self::AttemptSucceeded => "model.attempt.succeeded",
            Self::AttemptAbandonedAfterRestart => "model.attempt.abandoned_after_restart",
            Self::FallbackSelected => "model.fallback.selected",
        }
    }

    /// Parses a persisted event type.
    pub fn parse(value: &str) -> Option<Self> {
        [
            Self::AttemptStarted,
            Self::AttemptFailed,
            Self::AttemptSucceeded,
            Self::AttemptAbandonedAfterRestart,
            Self::FallbackSelected,
        ]
        .into_iter()
        .find(|kind| kind.as_str() == value)
    }
}

/// One event of a round's model route: an attempt transition or a fallback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRouteEvent {
    pub kind: ModelRouteEventKind,
    pub round_id: String,
    pub candidate_index: u32,
    pub model_ref: String,
    /// The transport attempt; fallback selections have none.
    pub transport_attempt: Option<u32>,
    /// Why a failed attempt failed and what the route does about it.
    pub failure: Option<AttemptFailure>,
}

/// The classified failure of one transport attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptFailure {
    pub error_code: String,
    pub disposition: FailureDisposition,
}

/// What the route does after a failed attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureDisposition {
    /// Retry the same candidate up to the route's retry ceiling.
    Retry,
    /// Fall back to the next candidate.
    Advance,
    /// Surface the failure to the turn.
    Surface,
}

impl FailureDisposition {
    /// The persisted (`snake_case`) name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Retry => "retry",
            Self::Advance => "advance",
            Self::Surface => "surface",
        }
    }

    /// Parses a persisted name.
    pub fn parse(value: &str) -> Option<Self> {
        [Self::Retry, Self::Advance, Self::Surface]
            .into_iter()
            .find(|disposition| disposition.as_str() == value)
    }
}

/// How the store handled a recorded model-route event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteEventStatus {
    /// The event was recorded.
    Recorded,
    /// A replayed start whose attempt already ended; nothing was recorded.
    AlreadyTerminal,
    /// A replayed start of an attempt a restart interrupted; it is now
    /// recorded as abandoned.
    AbandonedAfterRestart,
}

/// The transport attempts of one round candidate, grouped by outcome.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AttemptHistory {
    pub started: Vec<u32>,
    pub failed: Vec<u32>,
    /// Failed attempts that carry a known disposition.
    pub failed_details: Vec<FailureRecord>,
    pub succeeded: Vec<u32>,
    pub abandoned: Vec<u32>,
}

/// One failed attempt with its disposition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailureRecord {
    pub transport_attempt: u32,
    pub error_code: String,
    pub disposition: FailureDisposition,
}

/// Identifies one round candidate's attempts and acceptance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRoundKey {
    pub turn_id: String,
    pub round_id: String,
    pub route_digest: String,
    pub candidate_index: u32,
    pub model_ref: String,
    pub checkpoint_id: Option<String>,
    pub checkpoint_revision: Option<u64>,
}

/// Durably accepts a round's response (serialized `ModelRoundResult`).
#[derive(Clone, Debug, PartialEq)]
pub struct ModelRoundAcceptanceWrite {
    pub binding: ModelRouteWrite,
    pub key: ModelRoundKey,
    pub transport_attempt: u32,
    pub result: Value,
}

/// Applies a continuation-budget event under the turn claim.
#[derive(Clone, Debug, PartialEq)]
pub struct ContinuationBudgetTransition {
    pub binding: ModelRouteWrite,
    pub event: Value,
    pub now_ms: u64,
}

/// What the agent loop ended with: an answer or a suspension, and its facts.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentLoopResult {
    pub route: ExecutionRoute,
    pub content: String,
    pub terminal_outcome: Option<TerminalOutcome>,
    pub suspension: Option<SuspensionReason>,
    pub authority_continuation: Option<Box<AuthorityLoopContinuation>>,
    pub work_status: Option<WorkStatus>,
    pub accepted_work_result: Option<AcceptedWorkResult>,
    pub runtime_failure: Option<RuntimeFailure>,
    pub artifacts: Vec<FinalArtifact>,
    pub changed_files: Vec<ChangedFileSummary>,
    pub model_identity: Option<ModelIdentity>,
}

/// A terminal outcome without visible content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalOutcome {
    NoVisible,
}

/// How a turn was executed: directly, assisted by tools, or managed Work.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionRoute {
    Direct,
    Assisted,
    Managed,
}

/// A durable turn state change.
#[derive(Clone, Debug, PartialEq)]
pub enum TurnTransition {
    Suspend {
        reason: SuspensionReason,
        authority_continuation: Option<Box<AuthorityLoopContinuation>>,
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

/// The result of persisting a stop request.
#[derive(Clone, Debug, PartialEq)]
pub enum StopPersistenceOutcome {
    Cancelled,
    AlreadyCancelled,
    AlreadyFinalizing,
    AlreadyDelivered(Box<AlreadyDeliveredOutcome>),
}

/// Turn lifecycle progress events.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgressEvent {
    Started,
    StateChanged {
        semantic_state: TurnSemanticState,
        turn_revision: u64,
    },
    Cancelled,
}

/// A progress event to append for a turn.
#[derive(Clone, Debug, PartialEq)]
pub struct ProgressWrite {
    pub session_id: String,
    pub turn_id: String,
    pub destination: ProgressDestination,
    pub event: crate::btcc::RuntimeTurnEventInput,
}
