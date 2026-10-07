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
use super::transition::guided_transition;
use crate::btcc::BtccCode;
use crate::btcc::{BtccError, DeliveredOutcome, ProgressDestination, TurnOutcome, TurnOutcomeKind};

mod authority;

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
            turn = Box::pin(self.run_until_undecided(
                turn,
                conversation,
                &destination,
                prepared.request.recovery_attempt.unwrap_or(1),
            ))
            .await?;
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

    pub(super) fn interrupt(&self, turn_id: &str) {
        // A process-local fence also covers preparation and session-tail waits.
        // Keep durable state for the existing turn_interrupted retry path.
        self.supervisor.install_stop(turn_id);
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

    /// Runs the agent loop for an admitted turn and commits its outcome:
    /// a suspension, or the final payload (retrying through store contention).
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
            Err(AgentLoopError::Runtime(failure)) => runtime_failure_result(&turn, failure),
        };
        permit.assert_active()?;
        explain_runtime_failure(&turn, &mut result);
        let transition = guided_transition(&turn, result)?;
        let committed = self
            .commit_agent_transition(&turn, &claim, &transition, &permit)
            .await;
        super::super::agent_loop::authority_batch(&progress, &transition, committed.is_ok()).await;
        committed?;
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

    /// Commits the agent's transition. A suspension commits once; a final
    /// payload waits out store contention while the turn stays active.
    async fn commit_agent_transition(
        &self,
        turn: &TurnRecord,
        claim: &crate::btcc::StateExecutionClaim,
        transition: &TurnTransition,
        permit: &super::supervisor::ExecutionPermit,
    ) -> Result<(), BtccError> {
        if matches!(transition, TurnTransition::Suspend { .. }) {
            return self
                .store
                .commit_transition(turn, claim, transition)
                .await
                .map_err(commit_error);
        }
        loop {
            match self.store.commit_transition(turn, claim, transition).await {
                Ok(()) => return Ok(()),
                Err(TransitionCommitError::Contention) => {
                    self.readiness.wait(permit.cancellation()).await?;
                    permit.assert_active()?;
                }
                Err(TransitionCommitError::Failure(error)) => return Err(error),
            }
        }
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
                hold_stub_delivery("before", &turn.turn_id).await?;
                let message_id = self.messages.insert(&turn).await?;
                hold_stub_delivery("after", &turn.turn_id).await?;
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

/// The assisted answer recorded when the agent loop failed operationally.
fn runtime_failure_result(
    turn: &TurnRecord,
    failure: crate::btcc::RuntimeFailure,
) -> super::contracts::AgentLoopResult {
    super::contracts::AgentLoopResult {
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
        model_identity: None,
    }
}

/// A result with a runtime failure answers with the failure message (noting
/// completed Work) and is at least a failed Work result.
fn explain_runtime_failure(turn: &TurnRecord, result: &mut super::contracts::AgentLoopResult) {
    let Some(failure) = &result.runtime_failure else {
        return;
    };
    result.content = super::failure::runtime_failure_message_for_work(
        &turn.original_message,
        failure,
        result.accepted_work_result.as_ref(),
    );
    result
        .accepted_work_result
        .get_or_insert(crate::btcc::AcceptedWorkResult {
            status: crate::btcc::AcceptedWorkStatus::Failed,
        });
}

/// Stub-only crash windows around the durable canonical insert transaction.
async fn hold_stub_delivery(phase: &str, turn_id: &str) -> Result<(), BtccError> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub")
        || std::env::var("BUTLER_E2E_HOLD_DELIVERY").as_deref() != Ok(phase)
    {
        return Ok(());
    }
    let Some(data) = std::env::var_os("BUTLER_DATA") else {
        return Ok(());
    };
    let data = std::path::PathBuf::from(data);
    let io_error = |error: std::io::Error| {
        BtccError::detected(BtccCode::BtccTaskFailed, "stub delivery barrier failed")
            .with_source(error)
    };
    tokio::fs::write(data.join("e2e-delivery-held"), turn_id)
        .await
        .map_err(io_error)?;
    while !tokio::fs::try_exists(data.join("e2e-delivery-release"))
        .await
        .map_err(io_error)?
    {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    Ok(())
}
