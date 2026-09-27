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
    fn record_event<'a>(
        &'a self,
        event: &'a crate::btcc::RuntimeTurnEventInput,
    ) -> PortFuture<'a, ()>;
    fn complete(&self, outcome: TurnOutcome) -> PortFuture<'_, ()>;
    fn cancel(&self) -> PortFuture<'_, ()>;
}

/// Each mutation represents the matching existing SQLite transaction boundary.
pub trait TurnStore: Send + Sync {
    fn load_or_admit(&self, prepared: &PreparedTurn) -> PortFuture<'_, (TurnRecord, bool)>;
    fn find_turn(&self, turn_id: &str) -> PortFuture<'_, Option<TurnRecord>>;
    fn resume_authority(&self, turn_id: &str) -> PortFuture<'_, Option<TurnRecord>>;
    fn acquire_state_claim(&self, turn: &TurnRecord) -> PortFuture<'_, StateExecutionClaim>;
    fn commit_transition(
        &self,
        turn: &TurnRecord,
        claim: &StateExecutionClaim,
        transition: &TurnTransition,
    ) -> Pin<Box<dyn Future<Output = Result<(), TransitionCommitError>> + Send + '_>>;
    fn activate_successor(&self, turn_id: &str) -> PortFuture<'_, TurnRecord>;
    fn stop(&self, turn_id: &str) -> PortFuture<'_, StopPersistenceOutcome>;
    fn record_model_route_event(
        &self,
        write: ModelRouteEventWrite,
    ) -> PortFuture<'_, RouteEventStatus>;
    fn load_model_route_attempt_history(
        &self,
        key: ModelRoundKey,
    ) -> PortFuture<'_, AttemptHistory>;
    fn load_model_round_acceptance(&self, key: ModelRoundKey) -> PortFuture<'_, Option<Value>>;
    fn record_model_round_acceptance(&self, write: ModelRoundAcceptanceWrite)
    -> PortFuture<'_, ()>;
    fn transition_continuation_budget(
        &self,
        write: ContinuationBudgetTransition,
    ) -> PortFuture<'_, Value>;
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

pub trait AgentLoop: Send + Sync {
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

pub type TurnDeveloperLogFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

pub trait TurnDeveloperLogExecution: crate::btcc::ModelRoundObserver + Send + Sync {
    fn capture<'a>(
        &'a self,
        turn: &'a TurnRecord,
        result: Result<&'a AgentLoopResult, &'a AgentLoopError>,
    ) -> TurnDeveloperLogFuture<'a>;
}

pub trait TurnDeveloperLogCapturePort: Send + Sync {
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

pub trait AgentLoopProgress: Send + Sync {
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

pub trait CanonicalMessageStore: Send + Sync {
    fn insert(&self, turn: &TurnRecord) -> PortFuture<'_, String>;
}

pub trait ProgressEventRepository: Send + Sync {
    fn append(&self, write: ProgressWrite) -> PortFuture<'_, ()>;
    fn first_destination(
        &self,
        turn_id: &str,
    ) -> PortFuture<'_, Option<crate::btcc::ProgressDestination>>;
}

pub trait StorageReadiness: Send + Sync {
    fn wait(&self, cancellation: CancellationToken) -> PortFuture<'_, ()>;
}

pub trait HostDependencies: Send + Sync {
    fn close(&self) -> PortFuture<'_, ()>;
}
