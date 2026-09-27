use std::sync::Arc;

use super::contracts::{
    ProgressEvent, StopPersistenceOutcome, SuspensionReason, TurnRecord, TurnSemanticState,
    TurnTransition,
};
use super::failure::runtime_failure_message;
use super::ports::{
    AgentLoop, AgentLoopError, AgentLoopProgress, CanonicalMessageStore, PreparedConversation,
    ProgressEventRepository, StorageReadiness, TransitionCommitError, TurnStore,
};
use super::progress::TurnProgressScope;
use super::supervisor::TurnExecutionSupervisor;
use super::transition::guided_final;
use crate::btcc::BtccCode;
use crate::btcc::{BtccError, DeliveredOutcome, ProgressDestination, TurnOutcome, TurnOutcomeKind};

pub(super) struct TurnRuntime {
    store: Arc<dyn TurnStore>,
    agent: Arc<dyn AgentLoop>,
    messages: Arc<dyn CanonicalMessageStore>,
    progress: Arc<dyn ProgressEventRepository>,
    readiness: Arc<dyn StorageReadiness>,
    developer_log_capture: Arc<dyn super::ports::TurnDeveloperLogCapturePort>,
    supervisor: TurnExecutionSupervisor,
}

impl TurnRuntime {
    pub(super) fn new(
        store: Arc<dyn TurnStore>,
        agent: Arc<dyn AgentLoop>,
        messages: Arc<dyn CanonicalMessageStore>,
        progress: Arc<dyn ProgressEventRepository>,
        readiness: Arc<dyn StorageReadiness>,
        developer_log_capture: Arc<dyn super::ports::TurnDeveloperLogCapturePort>,
        supervisor: TurnExecutionSupervisor,
    ) -> Self {
        Self {
            store,
            agent,
            messages,
            progress,
            readiness,
            developer_log_capture,
            supervisor,
        }
    }

    pub(super) async fn run_prepared(
        &self,
        prepared: &super::contracts::PreparedTurn,
        conversation: &dyn PreparedConversation,
        destination: ProgressDestination,
    ) -> Result<(TurnOutcome, bool), BtccError> {
        let (mut turn, fresh) = self.store.load_or_admit(prepared).await?;
        if fresh && prepared.is_fresh && turn.semantic_state != TurnSemanticState::Cancelled {
            self.publish(conversation, &turn, &destination, ProgressEvent::Started)
                .await?;
        }
        if terminal(turn.semantic_state) {
            self.publish_state(conversation, &turn, &destination).await;
            return Ok((project_terminal(&turn)?, fresh));
        }
        if turn.suspension == Some(SuspensionReason::AuthorityPending) {
            turn = self
                .store
                .resume_authority(&turn.turn_id)
                .await?
                .unwrap_or(turn);
        }
        if let Some(reason) = turn.suspension {
            return Ok((suspended(&turn.turn_id, reason), fresh));
        }
        if turn.semantic_state == TurnSemanticState::Admitted {
            self.publish_state(conversation, &turn, &destination).await;
        }
        if turn.semantic_state != TurnSemanticState::DeliveryCommitted {
            let recovery_turn_id = turn.turn_id.clone();
            turn = match self
                .run_agent(
                    turn,
                    conversation,
                    &destination,
                    prepared.request.recovery_attempt.unwrap_or(1),
                )
                .await
            {
                Ok(turn) => turn,
                Err(error) => match self.store.find_turn(&recovery_turn_id).await {
                    Ok(Some(current)) if current.semantic_state == TurnSemanticState::Cancelled => {
                        current
                    }
                    _ => return Err(error),
                },
            };
        }
        if let Some(reason) = turn.suspension {
            return Ok((suspended(&turn.turn_id, reason), fresh));
        }
        if turn.semantic_state == TurnSemanticState::Cancelled {
            self.supervisor.observe_terminal(&turn.turn_id);
            self.publish_state(conversation, &turn, &destination).await;
            return Ok((project_terminal(&turn)?, fresh));
        }
        let delivered = self.deliver(turn, conversation, &destination).await?;
        Ok((project_terminal(&delivered)?, fresh))
    }

    pub(super) async fn stop(&self, turn_id: &str) -> Result<TurnOutcome, BtccError> {
        // The synchronous fence precedes the first repository await.
        let ticket = self.supervisor.install_stop(turn_id);
        match self.store.stop(turn_id).await {
            Ok(outcome) => {
                self.supervisor.observe_stop(&ticket, &outcome.clone());
                Ok(TurnOutcome {
                    result: stop_outcome(turn_id, outcome),
                    admission: None,
                })
            }
            Err(_) => {
                self.supervisor.observe_stop_failure(&ticket);
                Ok(TurnOutcome {
                    result: TurnOutcomeKind::FencedPendingPersistence {
                        turn_id: turn_id.to_owned(),
                    },
                    admission: None,
                })
            }
        }
    }

    async fn run_agent(
        &self,
        turn: TurnRecord,
        conversation: &dyn PreparedConversation,
        destination: &ProgressDestination,
        recovery_attempt: u32,
    ) -> Result<TurnRecord, BtccError> {
        let permit = self.supervisor.enter(&turn.turn_id, turn.semantic_state)?;
        let claim = self.store.acquire_state_claim(&turn).await?;
        let progress = self.progress_scope(conversation, &turn, destination);
        let developer_log = self.developer_log_capture.start_execution();
        let agent_result = self
            .agent
            .run(
                &turn,
                &claim,
                recovery_attempt,
                &progress,
                developer_log.as_ref(),
                permit.cancellation(),
            )
            .await;
        developer_log.capture(&turn, agent_result.as_ref()).await;
        let mut result = match agent_result {
            Ok(result) => result,
            Err(AgentLoopError::Propagate(error)) => return Err(error),
            Err(AgentLoopError::Runtime(failure)) => super::contracts::AgentLoopResult {
                route: super::contracts::ExecutionRoute::Assisted,
                content: runtime_failure_message(&turn.original_message, &failure),
                terminal_outcome: None,
                suspension: None,
                authority_continuation: None,
                work_status: None,
                accepted_work_result: Some(crate::btcc::AcceptedWorkResult {
                    status: crate::btcc::AcceptedWorkStatus::Failed,
                }),
                runtime_failure: Some(failure),
                artifacts: Vec::new(),
                changed_files: Vec::new(),
                plan: None,
                model_identity: None,
            },
        };
        permit.assert_active()?;
        if let Some(failure) = &result.runtime_failure {
            let work_completed = result
                .accepted_work_result
                .as_ref()
                .is_some_and(|value| value.status == crate::btcc::AcceptedWorkStatus::Success);
            result.content = super::failure::runtime_failure_message_for_work(
                &turn.original_message,
                failure,
                work_completed,
            );
            result
                .accepted_work_result
                .get_or_insert(crate::btcc::AcceptedWorkResult {
                    status: crate::btcc::AcceptedWorkStatus::Failed,
                });
        }
        let transition = if let Some(reason) = result.suspension {
            TurnTransition::Suspend {
                reason,
                authority_continuation: result.authority_continuation,
            }
        } else {
            guided_final(&turn, result)?
        };
        if matches!(transition, TurnTransition::Suspend { .. }) {
            self.store
                .commit_transition(&turn, &claim, &transition)
                .await
                .map_err(commit_error)?;
        } else {
            loop {
                match self
                    .store
                    .commit_transition(&turn, &claim, &transition)
                    .await
                {
                    Ok(()) => break,
                    Err(TransitionCommitError::Contention) => {
                        self.readiness.wait(permit.cancellation()).await?;
                        permit.assert_active()?;
                    }
                    Err(TransitionCommitError::Failure(error)) => return Err(error),
                }
            }
        }
        let committed = self.store.activate_successor(&turn.turn_id).await?;
        if let TurnTransition::Suspend { reason, .. } = transition {
            if committed.suspension != Some(reason) {
                return Err(BtccError::detected(
                    BtccCode::SuspensionNotPersisted,
                    "BTCC suspension commit did not persist its reason",
                ));
            }
            return Ok(committed);
        }
        self.publish_state(conversation, &committed, destination)
            .await;
        Ok(committed)
    }

    async fn deliver(
        &self,
        mut turn: TurnRecord,
        conversation: &dyn PreparedConversation,
        destination: &ProgressDestination,
    ) -> Result<TurnRecord, BtccError> {
        while turn.semantic_state == TurnSemanticState::DeliveryCommitted {
            let permit = self.supervisor.enter(&turn.turn_id, turn.semantic_state)?;
            let attempt = async {
                let claim = self.store.acquire_state_claim(&turn).await?;
                let message_id = self.messages.insert(&turn).await?;
                permit.assert_active()?;
                self.store
                    .commit_transition(
                        &turn,
                        &claim,
                        &TurnTransition::ObserveDelivery {
                            assistant_message_id: message_id,
                        },
                    )
                    .await
                    .map_err(commit_error)?;
                self.store.activate_successor(&turn.turn_id).await
            }
            .await;
            match attempt {
                Ok(successor) => turn = successor,
                Err(error) => {
                    let current = self.store.find_turn(&turn.turn_id).await.unwrap_or(None);
                    match current {
                        Some(current)
                            if permit.cancellation().is_cancelled()
                                && current.semantic_state
                                    == TurnSemanticState::DeliveryCommitted =>
                        {
                            turn = current;
                        }
                        Some(current) if terminal(current.semantic_state) => {
                            turn = current;
                            break;
                        }
                        _ => return Err(error),
                    }
                }
            }
        }
        if !terminal(turn.semantic_state) {
            return Err(BtccError::detected(
                BtccCode::InvalidDeliveryState,
                "Turn did not reach a terminal delivery state",
            ));
        }
        self.supervisor.observe_terminal(&turn.turn_id);
        self.publish_state(conversation, &turn, destination).await;
        Ok(turn)
    }

    async fn publish_state(
        &self,
        conversation: &dyn PreparedConversation,
        turn: &TurnRecord,
        destination: &ProgressDestination,
    ) {
        let _ = self
            .publish(
                conversation,
                turn,
                destination,
                ProgressEvent::StateChanged {
                    semantic_state: turn.semantic_state,
                    turn_revision: turn.revision,
                },
            )
            .await;
    }

    async fn publish(
        &self,
        conversation: &dyn PreparedConversation,
        turn: &TurnRecord,
        destination: &ProgressDestination,
        event: ProgressEvent,
    ) -> Result<(), BtccError> {
        self.progress_scope(conversation, turn, destination)
            .emit(crate::btcc::progress::project(event))
            .await
    }

    fn progress_scope<'a>(
        &'a self,
        conversation: &'a dyn PreparedConversation,
        turn: &'a TurnRecord,
        destination: &'a ProgressDestination,
    ) -> TurnProgressScope<'a> {
        TurnProgressScope {
            conversation,
            repository: self.progress.as_ref(),
            session_id: &turn.session_id,
            turn_id: &turn.turn_id,
            destination,
        }
    }
}

fn project_terminal(turn: &TurnRecord) -> Result<TurnOutcome, BtccError> {
    let result = if turn.semantic_state == TurnSemanticState::Cancelled {
        TurnOutcomeKind::Cancelled {
            turn_id: turn.turn_id.clone(),
        }
    } else {
        let payload = turn.final_payload.as_ref().ok_or_else(|| {
            BtccError::detected(
                BtccCode::MissingFinalPayload,
                "Delivered Turn has no final payload",
            )
        })?;
        let message_id = turn.canonical_assistant_message_id.clone().ok_or_else(|| {
            BtccError::detected(
                BtccCode::MissingCanonicalMessage,
                "Delivered Turn has no message",
            )
        })?;
        TurnOutcomeKind::Delivered(Box::new(DeliveredOutcome {
            turn_id: turn.turn_id.clone(),
            message_id,
            content: payload.content.clone(),
            work_status: payload.work_status,
            accepted_work_result: payload.accepted_work_result.clone(),
            runtime_failure: payload.runtime_failure.clone(),
            execution_outcome: payload.execution_outcome,
            artifacts: payload.artifacts.clone(),
            changed_files: payload.changed_files.clone(),
            plan: payload.plan.clone(),
            model_identity: payload.model_identity.clone(),
        }))
    };
    Ok(TurnOutcome {
        result,
        admission: None,
    })
}

fn stop_outcome(turn_id: &str, outcome: StopPersistenceOutcome) -> TurnOutcomeKind {
    match outcome {
        StopPersistenceOutcome::Cancelled => TurnOutcomeKind::Cancelled {
            turn_id: turn_id.into(),
        },
        StopPersistenceOutcome::AlreadyCancelled => TurnOutcomeKind::AlreadyCancelled {
            turn_id: turn_id.into(),
        },
        StopPersistenceOutcome::AlreadyFinalizing => TurnOutcomeKind::AlreadyFinalizing {
            turn_id: turn_id.into(),
        },
        StopPersistenceOutcome::AlreadyDelivered(delivered) => {
            TurnOutcomeKind::AlreadyDelivered(delivered)
        }
    }
}

fn suspended(turn_id: &str, reason: SuspensionReason) -> TurnOutcome {
    TurnOutcome {
        result: TurnOutcomeKind::Suspended {
            turn_id: turn_id.into(),
            reason: match reason {
                SuspensionReason::AuthorityPending => "authority_pending",
                SuspensionReason::WaitingForWorker => "waiting_for_worker",
            }
            .into(),
        },
        admission: None,
    }
}

fn terminal(state: TurnSemanticState) -> bool {
    matches!(
        state,
        TurnSemanticState::Delivered | TurnSemanticState::Cancelled
    )
}

fn commit_error(error: TransitionCommitError) -> BtccError {
    match error {
        TransitionCommitError::Contention => {
            BtccError::detected(BtccCode::SqliteContention, "delivery transition contention")
        }
        TransitionCommitError::Failure(error) => error,
    }
}
