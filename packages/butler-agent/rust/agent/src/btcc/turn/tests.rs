use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::Semaphore;

use super::test_support::{agent_result, apply_final, record, request};
use super::*;
use crate::btcc::*;

mod preparation;
mod prepared_lifetime;
mod progress_scope;

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
                .ok_or_else(|| BtccError::new("replay_identity_mismatch", "missing fixture"))
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
                .is_none_or(|token| token.is_cancelled()),
            Ordering::SeqCst,
        );
        self.stop_started.store(true, Ordering::SeqCst);
        let turn_id = turn_id.to_owned();
        Box::pin(async move {
            if self.block_stop.load(Ordering::SeqCst) {
                self.stop_permits.acquire().await.unwrap().forget();
            }
            if self.panic_stop.load(Ordering::SeqCst) {
                panic!("fixture TurnStore Stop panic");
            }
            if let Some(turn) = self.turns.lock().unwrap().get_mut(&turn_id) {
                turn.semantic_state = TurnSemanticState::Cancelled;
            }
            Ok(StopPersistenceOutcome::Cancelled)
        })
    }
    fn record_model_route_event(&self, _: ModelRouteEventWrite) -> PortFuture<'_, Option<Value>> {
        Box::pin(async { Ok(None) })
    }
    fn load_model_route_attempt_history(&self, _: ModelRoundKey) -> PortFuture<'_, Value> {
        Box::pin(async { Ok(json!({})) })
    }
    fn load_model_round_acceptance(&self, _: ModelRoundKey) -> PortFuture<'_, Option<Value>> {
        Box::pin(async { Ok(None) })
    }
    fn record_model_round_acceptance(&self, _: ModelRoundAcceptanceWrite) -> PortFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    fn transition_continuation_budget(
        &self,
        _: ContinuationBudgetTransition,
    ) -> PortFuture<'_, Value> {
        Box::pin(async { Ok(json!({})) })
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
                    _ = cancellation.cancelled() => return Err(AgentLoopError::Propagate(BtccError::new("turn_cancelled", "cancelled")))
                }
            }
            if self.panic_agent.load(Ordering::SeqCst) {
                panic!("fixture AgentLoop panic");
            }
            let mut result = agent_result();
            if self.suspend_agent.load(Ordering::SeqCst) {
                result.suspension = Some(SuspensionReason::WaitingForWorker);
                result.authority_continuation = Some(json!({"continuation": true}));
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
                Err(BtccError::new("progress_append_failed", "fixture failure"))
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

#[tokio::test]
async fn turn_outcome_follows_agent_result_progress_failures_and_resume_state() {
    enum Setup {
        Admitted,
        Suspending,
        StartedProgressFails,
        StateProgressFails,
        DeliveryCommitted,
    }
    for (setup, agent_calls) in [
        (Setup::Admitted, 1),
        (Setup::Suspending, 1),
        (Setup::StartedProgressFails, 0),
        (Setup::StateProgressFails, 1),
        (Setup::DeliveryCommitted, 0),
    ] {
        let mut turn = record("turn-1", "session-1", TurnSemanticState::Admitted);
        if matches!(setup, Setup::DeliveryCommitted) {
            apply_final(&mut turn);
        }
        let harness = Harness::new([turn]);
        match setup {
            Setup::Suspending => harness.suspend_agent.store(true, Ordering::SeqCst),
            Setup::StartedProgressFails => {
                harness.fail_started_progress.store(true, Ordering::SeqCst)
            }
            Setup::StateProgressFails => harness.fail_state_progress.store(true, Ordering::SeqCst),
            Setup::Admitted | Setup::DeliveryCommitted => {}
        }
        let assembly = crate::btcc::assemble(harness.dependencies());
        let outcome = assembly.btcc.run_turn(request("turn-1", "session-1")).await;
        assert_eq!(harness.calls.load(Ordering::SeqCst), agent_calls);
        let stored = harness.turns.lock().unwrap()["turn-1"].clone();
        match setup {
            Setup::Admitted | Setup::StateProgressFails | Setup::DeliveryCommitted => {
                // Delivery is committed exactly once; state progress cannot veto it.
                assert!(matches!(
                    outcome.unwrap().result,
                    TurnOutcomeKind::Delivered(_)
                ));
                assert_eq!(stored.semantic_state, TurnSemanticState::Delivered);
            }
            Setup::Suspending => {
                assert!(matches!(
                    outcome.unwrap().result,
                    TurnOutcomeKind::Suspended { .. }
                ));
                assert_eq!(stored.semantic_state, TurnSemanticState::Admitted);
                assert_eq!(stored.suspension, Some(SuspensionReason::WaitingForWorker));
            }
            Setup::StartedProgressFails => {
                assert_eq!(outcome.unwrap_err().code, "progress_append_failed");
            }
        }
    }
}

#[tokio::test]
async fn progress_uses_latest_request_queue_claim() {
    let mut admitted = record("turn-1", "session-1", TurnSemanticState::Admitted);
    admitted
        .progress_destination
        .as_mut()
        .unwrap()
        .app_queue_claim_id = Some("old".into());
    let harness = Harness::new([admitted]);
    let assembly = crate::btcc::assemble(harness.dependencies());
    let mut request = request("turn-1", "session-1");
    request.app_queue_claim_id = Some("latest".into());
    assembly.btcc.run_turn(request).await.unwrap();
    assert!(
        harness.progress.lock().unwrap().iter().all(|write| write
            .destination
            .app_queue_claim_id
            .as_deref()
            == Some("latest"))
    );
}

#[tokio::test]
async fn stop_bypasses_run_queue_and_fences_before_repository() {
    let harness = Harness::new([record("turn-1", "session-1", TurnSemanticState::Admitted)]);
    harness.block_agent.store(true, Ordering::SeqCst);
    let assembly = crate::btcc::assemble(harness.dependencies());
    let btcc = assembly.btcc.clone();
    let running = tokio::spawn(async move { btcc.run_turn(request("turn-1", "session-1")).await });
    crate::testing::eventually("agent loop entry", || {
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

#[tokio::test]
async fn duplicate_turn_id_shares_one_active_execution() {
    let harness = Harness::new([record("turn-1", "session-1", TurnSemanticState::Admitted)]);
    harness.block_agent.store(true, Ordering::SeqCst);
    let assembly = crate::btcc::assemble(harness.dependencies());
    let first_btcc = assembly.btcc.clone();
    let second_btcc = assembly.btcc.clone();
    let first =
        tokio::spawn(async move { first_btcc.run_turn(request("turn-1", "session-1")).await });
    crate::testing::eventually("agent loop entry", || {
        harness.calls.load(Ordering::SeqCst) > 0
    })
    .await;
    let second =
        tokio::spawn(async move { second_btcc.run_turn(request("turn-1", "session-1")).await });
    tokio::task::yield_now().await;
    assert_eq!(harness.calls.load(Ordering::SeqCst), 1);
    harness.permits.add_permits(1);
    assert!(matches!(
        first.await.unwrap().unwrap().result,
        TurnOutcomeKind::Delivered(_)
    ));
    assert!(matches!(
        second.await.unwrap().unwrap().result,
        TurnOutcomeKind::Delivered(_)
    ));
    assert_eq!(harness.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn close_drains_same_session_tail_then_closes_dependencies_once() {
    let harness = Harness::new([
        record("turn-1", "session-1", TurnSemanticState::Admitted),
        record("turn-2", "session-1", TurnSemanticState::Admitted),
    ]);
    harness.block_agent.store(true, Ordering::SeqCst);
    let assembly = crate::btcc::assemble(harness.dependencies());
    let first_btcc = assembly.btcc.clone();
    let second_btcc = assembly.btcc.clone();
    let first =
        tokio::spawn(async move { first_btcc.run_turn(request("turn-1", "session-1")).await });
    crate::testing::eventually("agent loop entry", || {
        harness.calls.load(Ordering::SeqCst) > 0
    })
    .await;
    let second =
        tokio::spawn(async move { second_btcc.run_turn(request("turn-2", "session-1")).await });
    crate::testing::eventually("second active turn", || {
        assembly.btcc.inner.active_count() == 2
    })
    .await;
    let host = assembly.host.clone();
    let closing = tokio::spawn(async move { host.close().await });
    tokio::task::yield_now().await;
    assert_eq!(harness.closes.load(Ordering::SeqCst), 0);
    harness.permits.add_permits(1);
    crate::testing::eventually("second turn entry", || {
        harness.calls.load(Ordering::SeqCst) == 2
    })
    .await;
    assert_eq!(harness.closes.load(Ordering::SeqCst), 0);
    harness.permits.add_permits(1);
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    closing.await.unwrap().unwrap();
    assembly.host.close().await.unwrap();
    assert_eq!(harness.closes.load(Ordering::SeqCst), 1);
}
