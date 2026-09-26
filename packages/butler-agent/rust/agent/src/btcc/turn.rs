mod contracts;
mod conversation;
mod failure;
mod host;
#[cfg(test)]
mod host_tests;
mod ports;
mod preparation;
mod progress;
mod runtime;
mod supervisor;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
mod transition;

use conversation::ConversationProjection;
use std::sync::Arc;

pub(crate) use preparation::{
    AdmissionContextPort, AdmissionModelCatalogPort, AdmissionModelCatalogSnapshot,
    AdmissionModelMetadata, ContextAssembly, ContextSection, DefaultTurnPreparation,
};

pub(crate) use contracts::{
    AgentLoopResult, ContentRef, ContinuationBudgetTransition, DeliveryOutbox, DeliveryStatus,
    ExecutionRoute, FinalDisposition, FinalPayload, ModelRoundAcceptanceWrite, ModelRoundKey,
    ModelRouteEventWrite, ModelRouteWrite, PreparedTurn, ProgressEvent, ProgressWrite,
    StateExecutionClaim, StopPersistenceOutcome, SuspensionReason, TerminalOutcome, TurnCheckpoint,
    TurnRecord, TurnSemanticState, TurnTransition, WakeIdentity,
};
#[cfg(test)]
pub(crate) use ports::NoopTurnDeveloperLogCapturePort;
pub(crate) use ports::{
    AgentLoop, AgentLoopError, AgentLoopProgress, CanonicalMessageStore, HostDependencies,
    PortFuture, PreparedConversation, PreparedExecution, ProgressEventRepository, StorageReadiness,
    TransitionCommitError, TurnDeveloperLogCapturePort, TurnDeveloperLogExecution,
    TurnDeveloperLogFuture, TurnPreparation, TurnStore,
};

use crate::btcc::{
    AdmissionKind, BtccError, ProgressDestination, TurnOutcome, TurnOutcomeKind, TurnRequest,
};
pub(crate) use host::Coordinator;
use runtime::TurnRuntime;
use supervisor::TurnExecutionSupervisor;

pub(crate) struct TurnFacadeDependencies {
    pub preparation: Arc<dyn TurnPreparation>,
    pub store: Arc<dyn TurnStore>,
    pub agent: Arc<dyn AgentLoop>,
    pub messages: Arc<dyn CanonicalMessageStore>,
    pub progress: Arc<dyn ProgressEventRepository>,
    pub readiness: Arc<dyn StorageReadiness>,
    pub developer_log_capture: Arc<dyn TurnDeveloperLogCapturePort>,
    pub host: Arc<dyn HostDependencies>,
}

pub(super) struct TurnFacade {
    preparation: Arc<dyn TurnPreparation>,
    store: Arc<dyn TurnStore>,
    progress: Arc<dyn ProgressEventRepository>,
    runtime: TurnRuntime,
}

impl TurnFacade {
    pub(super) fn new(dependencies: &TurnFacadeDependencies) -> Self {
        let supervisor = TurnExecutionSupervisor::default();
        Self {
            preparation: dependencies.preparation.clone(),
            store: dependencies.store.clone(),
            progress: dependencies.progress.clone(),
            runtime: TurnRuntime::new(
                dependencies.store.clone(),
                dependencies.agent.clone(),
                dependencies.messages.clone(),
                dependencies.progress.clone(),
                dependencies.readiness.clone(),
                dependencies.developer_log_capture.clone(),
                supervisor,
            ),
        }
    }

    pub(super) async fn run(&self, request: TurnRequest) -> Result<TurnOutcome, BtccError> {
        let execution = self.preparation.prepare(request).await?;
        let prepared = &execution.turn;
        let admitted = self.store.find_turn(&prepared.request.turn_id).await?;
        let destination = progress_destination(admitted.as_ref(), &prepared.request);
        let (mut outcome, _runtime_fresh) = self
            .runtime
            .run_prepared(prepared, execution.conversation.as_ref(), destination)
            .await?;
        outcome.admission = Some(if prepared.is_fresh {
            AdmissionKind::Fresh
        } else {
            AdmissionKind::Replay
        });
        match &outcome.result {
            TurnOutcomeKind::Delivered(_) | TurnOutcomeKind::AlreadyDelivered(_) => {
                execution.conversation.complete(outcome.clone()).await?;
            }
            TurnOutcomeKind::Cancelled { .. } | TurnOutcomeKind::AlreadyCancelled { .. } => {
                execution.conversation.cancel().await?;
            }
            _ => {}
        }
        Ok(outcome)
    }

    pub(super) async fn stop(&self, turn_id: &str) -> Result<TurnOutcome, BtccError> {
        let outcome = self.runtime.stop(turn_id).await?;
        if matches!(
            &outcome.result,
            TurnOutcomeKind::Cancelled { .. } | TurnOutcomeKind::AlreadyCancelled { .. }
        ) {
            let persisted = self.store.find_turn(turn_id).await.unwrap_or(None);
            let Some(turn) =
                persisted.filter(|turn| turn.semantic_state == TurnSemanticState::Cancelled)
            else {
                return if matches!(&outcome.result, TurnOutcomeKind::Cancelled { .. }) {
                    Ok(fenced(turn_id))
                } else {
                    Ok(outcome)
                };
            };
            let destination = match turn.progress_destination.clone() {
                Some(value) => Some(value),
                None => self.progress.first_destination(turn_id).await?,
            };
            let Some(destination) = destination else {
                return Ok(fenced(turn_id));
            };
            self.progress
                .append(ProgressWrite {
                    session_id: turn.session_id,
                    turn_id: turn.turn_id,
                    destination,
                    event: super::progress::project(ProgressEvent::Cancelled),
                })
                .await?;
        }
        Ok(outcome)
    }
}

fn fenced(turn_id: &str) -> TurnOutcome {
    TurnOutcome {
        result: TurnOutcomeKind::FencedPendingPersistence {
            turn_id: turn_id.to_owned(),
        },
        admission: None,
    }
}

fn progress_destination(
    admitted: Option<&TurnRecord>,
    request: &TurnRequest,
) -> ProgressDestination {
    let mut destination = admitted
        .and_then(|turn| turn.progress_destination.clone())
        .or_else(|| request.progress_destination.clone())
        .unwrap_or_else(|| ProgressDestination {
            transport: request.transport.clone(),
            account_id: request.account_id.clone(),
            peer: request.peer.clone(),
            reply_to_message_id: request.message.id.clone(),
            app_queue_claim_id: request.app_queue_claim_id.clone(),
        });
    if request.app_queue_claim_id.is_some() {
        destination.app_queue_claim_id = request.app_queue_claim_id.clone();
    }
    destination
}

pub(crate) fn assemble(dependencies: TurnFacadeDependencies) -> Arc<Coordinator> {
    let host = dependencies.host.clone();
    Arc::new(Coordinator::new(
        Arc::new(TurnFacade::new(&dependencies)),
        host,
    ))
}

impl Coordinator {
    pub(crate) async fn run_turn(
        self: &Arc<Self>,
        request: TurnRequest,
    ) -> Result<TurnOutcome, BtccError> {
        self.run(request).await
    }

    pub(crate) async fn stop_turn(
        self: &Arc<Self>,
        turn_id: &str,
    ) -> Result<TurnOutcome, BtccError> {
        self.stop(turn_id).await
    }

    pub(crate) async fn close_host(self: &Arc<Self>) -> Result<(), BtccError> {
        self.close().await
    }
}
