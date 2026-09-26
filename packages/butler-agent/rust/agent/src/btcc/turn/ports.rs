use std::future::Future;
use std::pin::Pin;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::contracts::{
    AgentLoopResult, ContinuationBudgetTransition, ModelRoundAcceptanceWrite, ModelRoundKey,
    ModelRouteEventWrite, PreparedTurn, ProgressWrite, StateExecutionClaim, StopPersistenceOutcome,
    TurnRecord, TurnTransition,
};
use crate::btcc::{BtccError, TurnOutcome, TurnRequest};

pub(crate) type PortFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, BtccError>> + Send + 'a>>;

/// Admission data can cross the SQLite lane; the conversation owner cannot.
pub(crate) struct PreparedExecution {
    pub turn: PreparedTurn,
    pub conversation: Box<dyn PreparedConversation>,
}

pub(crate) trait TurnPreparation: Send + Sync {
    fn prepare(&self, request: TurnRequest) -> PortFuture<'_, PreparedExecution>;
}

/// Owned by one prepared execution, including failure and suspension paths.
/// Drop releases local admission state; durable completion remains explicit.
pub(crate) trait PreparedConversation: Send + Sync {
    fn record_event<'a>(
        &'a self,
        event: &'a crate::btcc::RuntimeTurnEventInput,
    ) -> PortFuture<'a, ()>;
    fn complete(&self, outcome: TurnOutcome) -> PortFuture<'_, ()>;
    fn cancel(&self) -> PortFuture<'_, ()>;
}

/// Each mutation represents the matching existing SQLite transaction boundary.
pub(crate) trait TurnStore: Send + Sync {
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
    ) -> PortFuture<'_, Option<Value>>;
    fn load_model_route_attempt_history(&self, key: ModelRoundKey) -> PortFuture<'_, Value>;
    fn load_model_round_acceptance(&self, key: ModelRoundKey) -> PortFuture<'_, Option<Value>>;
    fn record_model_round_acceptance(&self, write: ModelRoundAcceptanceWrite)
    -> PortFuture<'_, ()>;
    fn transition_continuation_budget(
        &self,
        write: ContinuationBudgetTransition,
    ) -> PortFuture<'_, Value>;
}

#[derive(Debug)]
pub(crate) enum TransitionCommitError {
    Contention,
    Failure(BtccError),
}

pub(crate) trait AgentLoop: Send + Sync {
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

pub(crate) type TurnDeveloperLogFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

pub(crate) trait TurnDeveloperLogExecution:
    crate::btcc::ModelRoundObserver + Send + Sync
{
    fn capture<'a>(
        &'a self,
        turn: &'a TurnRecord,
        result: Result<&'a AgentLoopResult, &'a AgentLoopError>,
    ) -> TurnDeveloperLogFuture<'a>;
}

pub(crate) trait TurnDeveloperLogCapturePort: Send + Sync {
    fn start_execution(&self) -> Box<dyn TurnDeveloperLogExecution>;
}

#[cfg(test)]
pub(crate) struct NoopTurnDeveloperLogCapturePort;

#[cfg(test)]
struct NoopTurnDeveloperLogExecution;

#[cfg(test)]
impl TurnDeveloperLogCapturePort for NoopTurnDeveloperLogCapturePort {
    fn start_execution(&self) -> Box<dyn TurnDeveloperLogExecution> {
        Box::new(NoopTurnDeveloperLogExecution)
    }
}

#[cfg(test)]
impl crate::btcc::ModelRoundObserver for NoopTurnDeveloperLogExecution {}

#[cfg(test)]
impl TurnDeveloperLogExecution for NoopTurnDeveloperLogExecution {
    fn capture<'a>(
        &'a self,
        _: &'a TurnRecord,
        _: Result<&'a AgentLoopResult, &'a AgentLoopError>,
    ) -> TurnDeveloperLogFuture<'a> {
        Box::pin(async {})
    }
}

pub(crate) trait AgentLoopProgress: Send + Sync {
    fn emit(&self, event: crate::btcc::RuntimeTurnEventInput) -> PortFuture<'_, ()>;
}

#[derive(Debug)]
pub(crate) enum AgentLoopError {
    Propagate(BtccError),
    Runtime(crate::btcc::RuntimeFailure),
}

pub(crate) trait CanonicalMessageStore: Send + Sync {
    fn insert(&self, turn: &TurnRecord) -> PortFuture<'_, String>;
}

pub(crate) trait ProgressEventRepository: Send + Sync {
    fn append(&self, write: ProgressWrite) -> PortFuture<'_, ()>;
    fn first_destination(
        &self,
        turn_id: &str,
    ) -> PortFuture<'_, Option<crate::btcc::ProgressDestination>>;
}

pub(crate) trait StorageReadiness: Send + Sync {
    fn wait(&self, cancellation: CancellationToken) -> PortFuture<'_, ()>;
}

pub(crate) trait HostDependencies: Send + Sync {
    fn close(&self) -> PortFuture<'_, ()>;
}
