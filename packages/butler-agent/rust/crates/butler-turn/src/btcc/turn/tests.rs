use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Semaphore;

use super::test_support::{agent_result, record, request};
use super::*;
use crate::btcc::*;

mod preparation;

pub(super) struct Harness {
    turns: Mutex<HashMap<String, TurnRecord>>,
    pub(super) calls: AtomicUsize,
    pub(super) closes: AtomicUsize,
    stop_saw_cancelled_token: AtomicBool,
    pub(super) stop_started: AtomicBool,
    pub(super) stop_calls: AtomicUsize,
    pub(super) block_stop: AtomicBool,
    pub(super) panic_stop: AtomicBool,
    pub(super) stop_permits: Semaphore,
    last_token: Mutex<Option<tokio_util::sync::CancellationToken>>,
    pub(super) permits: Semaphore,
    pub(super) block_agent: AtomicBool,
    pub(super) panic_agent: AtomicBool,
    progress: Mutex<Vec<ProgressWrite>>,
    fail_started_progress: AtomicBool,
    fail_state_progress: AtomicBool,
    suspend_agent: AtomicBool,
}

impl Harness {
    pub(super) fn new(records: impl IntoIterator<Item = TurnRecord>) -> Arc<Self> {
        Arc::new(Self {
            turns: Mutex::new(
                records
                    .into_iter()
                    .map(|turn| (turn.turn_id.clone(), turn))
                    .collect(),
            ),
            calls: AtomicUsize::new(0),
            closes: AtomicUsize::new(0),
            stop_saw_cancelled_token: AtomicBool::new(false),
            stop_started: AtomicBool::new(false),
            stop_calls: AtomicUsize::new(0),
            block_stop: AtomicBool::new(false),
            panic_stop: AtomicBool::new(false),
            stop_permits: Semaphore::new(0),
            last_token: Mutex::new(None),
            permits: Semaphore::new(0),
            block_agent: AtomicBool::new(false),
            panic_agent: AtomicBool::new(false),
            progress: Mutex::new(Vec::new()),
            fail_started_progress: AtomicBool::new(false),
            fail_state_progress: AtomicBool::new(false),
            suspend_agent: AtomicBool::new(false),
        })
    }

    pub(super) fn dependencies(self: &Arc<Self>) -> TurnFacadeDependencies {
        TurnFacadeDependencies {
            preparation: self.clone(),
            store: self.clone(),
            agent: self.clone(),
            messages: self.clone(),
            progress: self.clone(),
            readiness: self.clone(),
            developer_log_capture: Arc::new(NoopTurnDeveloperLogCapturePort),
            host: self.clone(),
        }
    }
}

impl TurnStore for Harness {
    fn load_or_admit(&self, prepared: &PreparedTurn) -> PortFuture<'_, (TurnRecord, bool)> {
        let result = self
            .turns
            .lock()
            .unwrap()
            .get(&prepared.request.turn_id)
            .cloned();
        Box::pin(async move {
            result
                .map(|turn| (turn, true))
                .ok_or_else(|| BtccError::relayed("replay_identity_mismatch", "missing fixture"))
        })
    }
    fn find_turn(&self, turn_id: &str) -> PortFuture<'_, Option<TurnRecord>> {
        let value = self.turns.lock().unwrap().get(turn_id).cloned();
        Box::pin(async move { Ok(value) })
    }
    fn resume_authority(&self, turn_id: &str) -> PortFuture<'_, Option<TurnRecord>> {
        self.find_turn(turn_id)
    }
    fn acquire_state_claim(&self, turn: &TurnRecord) -> PortFuture<'_, StateExecutionClaim> {
        let claim = StateExecutionClaim {
            claim_id: format!("claim-{}", turn.revision),
            turn_id: turn.turn_id.clone(),
            turn_revision: turn.revision,
            semantic_state: turn.semantic_state,
            checkpoint_id: "checkpoint".into(),
            checkpoint_revision: turn.revision,
            execution_fence: turn.execution_fence,
        };
        Box::pin(async move { Ok(claim) })
    }
    fn commit_transition(
        &self,
        turn: &TurnRecord,
        _: &StateExecutionClaim,
        transition: &TurnTransition,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), TransitionCommitError>> + Send + '_>,
    > {
        let mut turns = self.turns.lock().unwrap();
        let stored = turns.get_mut(&turn.turn_id).unwrap();
        match transition {
            TurnTransition::Suspend {
                reason,
                authority_continuation,
            } => {
                stored.suspension = Some(*reason);
                stored.authority_continuation = authority_continuation.clone();
            }
            TurnTransition::AcceptFinal {
                route,
                payload,
                outbox,
            } => {
                stored.semantic_state = TurnSemanticState::DeliveryCommitted;
                stored.route = Some(*route);
                stored.final_payload = Some((**payload).clone());
                stored.delivery_outbox = Some((**outbox).clone());
            }
            TurnTransition::ObserveDelivery {
                assistant_message_id,
            } => {
                stored.semantic_state = TurnSemanticState::Delivered;
                stored.canonical_assistant_message_id = Some(assistant_message_id.clone());
            }
        }
        stored.revision += 1;
        Box::pin(async { Ok(()) })
    }
    fn activate_successor(&self, turn_id: &str) -> PortFuture<'_, TurnRecord> {
        let value = self.turns.lock().unwrap().get(turn_id).cloned().unwrap();
        Box::pin(async move { Ok(value) })
    }
    fn stop(&self, turn_id: &str) -> PortFuture<'_, StopPersistenceOutcome> {
        self.stop_calls.fetch_add(1, Ordering::SeqCst);
        self.stop_saw_cancelled_token.store(
            self.last_token
                .lock()
                .unwrap()
                .as_ref()
                .is_none_or(tokio_util::sync::CancellationToken::is_cancelled),
            Ordering::SeqCst,
        );
        self.stop_started.store(true, Ordering::SeqCst);
        let turn_id = turn_id.to_owned();
        Box::pin(async move {
            if self.block_stop.load(Ordering::SeqCst) {
                self.stop_permits.acquire().await.unwrap().forget();
            }
            assert!(
                !self.panic_stop.load(Ordering::SeqCst),
                "fixture TurnStore Stop panic"
            );
            if let Some(turn) = self.turns.lock().unwrap().get_mut(&turn_id) {
                turn.semantic_state = TurnSemanticState::Cancelled;
            }
            Ok(StopPersistenceOutcome::Cancelled)
        })
    }
    fn record_model_route_event(
        &self,
        _: ModelRouteEventWrite,
    ) -> PortFuture<'_, crate::btcc::RouteEventStatus> {
        Box::pin(async { Ok(crate::btcc::RouteEventStatus::Recorded) })
    }
    fn load_model_route_attempt_history(
        &self,
        _: ModelRoundKey,
    ) -> PortFuture<'_, crate::btcc::AttemptHistory> {
        Box::pin(async { Ok(crate::btcc::AttemptHistory::default()) })
    }
    fn load_model_round_acceptance(
        &self,
        _: ModelRoundKey,
    ) -> PortFuture<'_, Option<crate::btcc::ModelRoundResult>> {
        Box::pin(async { Ok(None) })
    }
    fn record_model_round_acceptance(&self, _: ModelRoundAcceptanceWrite) -> PortFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    fn transition_continuation_budget(
        &self,
        _: ContinuationBudgetTransition,
    ) -> PortFuture<'_, crate::btcc::TurnContinuationBudgetState> {
        Box::pin(async { panic!("not used by this test") })
    }
}

impl AgentLoop for Harness {
    fn run<'a>(
        &'a self,
        _: &'a TurnRecord,
        _: &'a StateExecutionClaim,
        _: u32,
        _: &'a dyn crate::btcc::AgentLoopProgress,
        _: &'a dyn crate::btcc::ModelRoundObserver,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<AgentLoopResult, AgentLoopError>> + Send + 'a>,
    > {
        self.calls.fetch_add(1, Ordering::SeqCst);
        *self.last_token.lock().unwrap() = Some(cancellation.clone());
        Box::pin(async move {
            if self.block_agent.load(Ordering::SeqCst) {
                tokio::select! {
                    permit = self.permits.acquire() => permit.unwrap().forget(),
                    () = cancellation.cancelled() => return Err(AgentLoopError::Propagate(BtccError::relayed("turn_cancelled", "cancelled")))
                }
            }
            assert!(
                !self.panic_agent.load(Ordering::SeqCst),
                "fixture AgentLoop panic"
            );
            let mut result = agent_result();
            if self.suspend_agent.load(Ordering::SeqCst) {
                result.suspension = Some(SuspensionReason::WaitingForWorker);
                result.authority_continuation = Some(Box::new(
                    crate::btcc::AuthorityLoopContinuation::fixture("request", "call"),
                ));
            }
            Ok(result)
        })
    }
}

impl CanonicalMessageStore for Harness {
    fn insert(&self, turn: &TurnRecord) -> PortFuture<'_, String> {
        let id = turn
            .delivery_outbox
            .as_ref()
            .unwrap()
            .expected_message_id
            .clone();
        Box::pin(async move { Ok(id) })
    }
}
impl ProgressEventRepository for Harness {
    fn append(&self, write: ProgressWrite) -> PortFuture<'_, ()> {
        let should_fail = match write.event.kind.as_str() {
            "turn.started" => self.fail_started_progress.load(Ordering::SeqCst),
            "turn.cancelled" => false,
            _ => self.fail_state_progress.load(Ordering::SeqCst),
        };
        self.progress.lock().unwrap().push(write);
        Box::pin(async move {
            if should_fail {
                Err(BtccError::relayed(
                    "progress_append_failed",
                    "fixture failure",
                ))
            } else {
                Ok(())
            }
        })
    }
    fn first_destination(&self, turn_id: &str) -> PortFuture<'_, Option<ProgressDestination>> {
        let value = self
            .progress
            .lock()
            .unwrap()
            .iter()
            .find(|write| write.turn_id == turn_id)
            .map(|write| write.destination.clone());
        Box::pin(async move { Ok(value) })
    }
}
impl StorageReadiness for Harness {
    fn wait(&self, _: tokio_util::sync::CancellationToken) -> PortFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}
impl HostDependencies for Harness {
    fn close(&self) -> PortFuture<'_, ()> {
        self.closes.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

/// Race: Stop wins against in-flight work. It bypasses the run queue and
/// fences before the repository, and it cancels a turn claim together with
/// the same session's authority in one transaction.
// test-category: race
#[tokio::test]
async fn stop_wins_against_queued_and_claimed_turns() {
    stop_bypasses_run_queue_and_fences_before_repository().await;
    crate::btcc::storage::repository_tests::stop::stop_cancels_turn_claim_and_same_session_authority_atomically().await;
}

async fn stop_bypasses_run_queue_and_fences_before_repository() {
    let harness = Harness::new([record("turn-1", "session-1", TurnSemanticState::Admitted)]);
    harness.block_agent.store(true, Ordering::SeqCst);
    let assembly = crate::btcc::assemble(&harness.dependencies());
    let btcc = assembly.btcc.clone();
    let running = tokio::spawn(async move { btcc.run_turn(request("turn-1", "session-1")).await });
    butler_test_support::eventually("agent loop entry", || {
        harness.calls.load(Ordering::SeqCst) > 0
    })
    .await;
    let stopped = assembly
        .btcc
        .stop_turn(StopRequest {
            turn_id: "turn-1".into(),
        })
        .await
        .unwrap();
    assert!(matches!(stopped.result, TurnOutcomeKind::Cancelled { .. }));
    assert!(harness.stop_saw_cancelled_token.load(Ordering::SeqCst));
    assert!(matches!(
        running.await.unwrap().unwrap().result,
        TurnOutcomeKind::Cancelled { .. }
    ));
}
