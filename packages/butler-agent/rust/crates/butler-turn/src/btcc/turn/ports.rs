use std::future::Future;
use std::pin::Pin;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::contracts::{
    AgentLoopResult, AttemptHistory, ContinuationBudgetTransition, ModelRoundAcceptanceWrite,
    ModelRoundKey, ModelRouteEventWrite, PreparedTurn, ProgressWrite, RouteEventStatus,
    StateExecutionClaim, StopPersistenceOutcome, TurnRecord, TurnTransition,
};
use crate::btcc::{BtccError, TurnOutcome, TurnRequest};

/// A boxed turn-runtime port operation.
pub type PortFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, BtccError>> + Send + 'a>>;

/// Admission data can cross the SQLite lane; the conversation owner cannot.
pub struct PreparedExecution {
    pub turn: PreparedTurn,
    pub conversation: Box<dyn PreparedConversation>,
}

pub trait TurnPreparation: Send + Sync {
    fn prepare(&self, request: TurnRequest) -> PortFuture<'_, PreparedExecution>;
}

/// Owned by one prepared execution, including failure and suspension paths.
/// Drop releases local admission state; durable completion remains explicit.
pub trait PreparedConversation: Send + Sync {
    /// Records a runtime event in the turn's conversation projection.
    fn record_event<'a>(
        &'a self,
        event: &'a crate::btcc::RuntimeTurnEventInput,
    ) -> PortFuture<'a, ()>;
    /// Finalizes the conversation turn with the turn outcome.
    fn complete(&self, outcome: TurnOutcome) -> PortFuture<'_, ()>;
    /// Finalizes the conversation turn as cancelled.
    fn cancel(&self) -> PortFuture<'_, ()>;
}

/// Each mutation represents the matching existing SQLite transaction boundary.
pub trait TurnStore: Send + Sync {
    /// The stored turn, admitting it first when new (`true` when admitted now).
    fn load_or_admit(&self, prepared: &PreparedTurn) -> PortFuture<'_, (TurnRecord, bool)>;
    /// The stored turn, if any.
    fn find_turn(&self, turn_id: &str) -> PortFuture<'_, Option<TurnRecord>>;
    /// Resumes a turn suspended on a decided authority request.
    fn resume_authority(&self, turn_id: &str) -> PortFuture<'_, Option<TurnRecord>>;
    /// Claims execution of the turn's active checkpoint for this runtime.
    fn acquire_state_claim(&self, turn: &TurnRecord) -> PortFuture<'_, StateExecutionClaim>;
    /// Commits a transition under the claim; contention is retryable.
    fn commit_transition(
        &self,
        turn: &TurnRecord,
        claim: &StateExecutionClaim,
        transition: &TurnTransition,
    ) -> Pin<Box<dyn Future<Output = Result<(), TransitionCommitError>> + Send + '_>>;
    /// Activates the turn's next checkpoint after a commit and returns the turn.
    fn activate_successor(&self, turn_id: &str) -> PortFuture<'_, TurnRecord>;
    /// Persists a stop request for the turn.
    fn stop(&self, turn_id: &str) -> PortFuture<'_, StopPersistenceOutcome>;
    /// Records a model-route event under the turn claim.
    fn record_model_route_event(
        &self,
        write: ModelRouteEventWrite,
    ) -> PortFuture<'_, RouteEventStatus>;
    /// The attempt history of one round candidate.
    fn load_model_route_attempt_history(
        &self,
        key: ModelRoundKey,
    ) -> PortFuture<'_, AttemptHistory>;
    /// The durably accepted response of a round candidate (serialized `ModelRoundResult`).
    fn load_model_round_acceptance(&self, key: ModelRoundKey) -> PortFuture<'_, Option<Value>>;
    /// Durably accepts a round's response.
    fn record_model_round_acceptance(&self, write: ModelRoundAcceptanceWrite)
    -> PortFuture<'_, ()>;
    /// Applies a continuation-budget event and returns the new budget state.
    fn transition_continuation_budget(
        &self,
        write: ContinuationBudgetTransition,
    ) -> PortFuture<'_, crate::btcc::TurnContinuationBudgetState>;
}

/// A turn transition could not be committed.
#[derive(Debug, thiserror::Error)]
pub enum TransitionCommitError {
    /// Another owner committed first; the caller retries.
    #[error("turn transition contention")]
    Contention,
    /// The commit failed.
    #[error(transparent)]
    Failure(BtccError),
}

/// Runs the model/tool loop of an admitted turn.
pub trait AgentLoop: Send + Sync {
    /// Runs the turn under its claim until it answers, suspends or fails.
    fn run<'a>(
        &'a self,
        turn: &'a TurnRecord,
        claim: &'a StateExecutionClaim,
        recovery_attempt: u32,
        progress: &'a dyn AgentLoopProgress,
        model_round_observer: &'a dyn crate::btcc::ModelRoundObserver,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<AgentLoopResult, AgentLoopError>> + Send + 'a>>;
}

/// A boxed developer-log capture.
pub type TurnDeveloperLogFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

/// Developer-log capture of one turn execution (diagnostic only).
pub trait TurnDeveloperLogExecution: crate::btcc::ModelRoundObserver + Send + Sync {
    /// Captures the execution's result or error.
    fn capture<'a>(
        &'a self,
        turn: &'a TurnRecord,
        result: Result<&'a AgentLoopResult, &'a AgentLoopError>,
    ) -> TurnDeveloperLogFuture<'a>;
}

/// Starts developer-log captures.
pub trait TurnDeveloperLogCapturePort: Send + Sync {
    /// A capture for one turn execution.
    fn start_execution(&self) -> Box<dyn TurnDeveloperLogExecution>;
}

#[cfg(any(test, feature = "test-support"))]
pub(crate) struct NoopTurnDeveloperLogCapturePort;

#[cfg(any(test, feature = "test-support"))]
struct NoopTurnDeveloperLogExecution;

#[cfg(any(test, feature = "test-support"))]
impl TurnDeveloperLogCapturePort for NoopTurnDeveloperLogCapturePort {
    fn start_execution(&self) -> Box<dyn TurnDeveloperLogExecution> {
        Box::new(NoopTurnDeveloperLogExecution)
    }
}

#[cfg(any(test, feature = "test-support"))]
impl crate::btcc::ModelRoundObserver for NoopTurnDeveloperLogExecution {}

#[cfg(any(test, feature = "test-support"))]
impl TurnDeveloperLogExecution for NoopTurnDeveloperLogExecution {
    fn capture<'a>(
        &'a self,
        _: &'a TurnRecord,
        _: Result<&'a AgentLoopResult, &'a AgentLoopError>,
    ) -> TurnDeveloperLogFuture<'a> {
        Box::pin(async {})
    }
}

/// Publishes runtime progress events of a running turn.
pub trait AgentLoopProgress: Send + Sync {
    /// Publishes one progress event.
    fn emit(&self, event: crate::btcc::RuntimeTurnEventInput) -> PortFuture<'_, ()>;
}

/// The agent loop ended with an error.
#[derive(Debug, thiserror::Error)]
pub enum AgentLoopError {
    /// An integrity failure that ends the turn.
    #[error(transparent)]
    Propagate(BtccError),
    /// An operational failure recorded as the turn's runtime failure.
    #[error("{0}")]
    Runtime(crate::btcc::RuntimeFailure),
}

/// Inserts a turn's delivered answer into the canonical conversation.
pub trait CanonicalMessageStore: Send + Sync {
    /// Inserts the turn's outbox content and returns the assistant message id.
    fn insert(&self, turn: &TurnRecord) -> PortFuture<'_, String>;
}

/// Durable progress events of turns.
pub trait ProgressEventRepository: Send + Sync {
    /// Appends one progress event.
    fn append(&self, write: ProgressWrite) -> PortFuture<'_, ()>;
    /// Where the turn's progress was first published, if anywhere.
    fn first_destination(
        &self,
        turn_id: &str,
    ) -> PortFuture<'_, Option<crate::btcc::ProgressDestination>>;
}

/// Waits for storage to accept writes again after contention.
pub trait StorageReadiness: Send + Sync {
    /// Resolves when storage is ready or the cancellation fires.
    fn wait(&self, cancellation: CancellationToken) -> PortFuture<'_, ()>;
}

/// Owners the turn host closes when it shuts down.
pub trait HostDependencies: Send + Sync {
    /// Closes the owners after every active turn settled.
    fn close(&self) -> PortFuture<'_, ()>;
}
