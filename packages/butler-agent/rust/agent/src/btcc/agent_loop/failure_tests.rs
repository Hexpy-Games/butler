use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::btcc::model_route::{ModelExecutionFactory, ModelExecutionInput};
use crate::btcc::{
    AgentLoopError, BtccError, PortFuture, TurnContinuationBudgetLimits, TurnContinuationBudgetPort,
};

use super::contracts::{ContextProjection, ContextProjectionInput, PreparedPolicy};
use super::driver::Invocation;
use super::guided_ports::{GuidedInvocation, TurnContextProjection};
use super::model_round::run_model_round;
use super::ports::{
    ContextProjectionError, ContextProjectionFuture, GuidedPolicyPort, ModelRoundError,
};
use super::state::State;
use super::test_data::{claim, result, turn};
use super::test_support::Fixture;

enum Failure {
    Context,
    Provider,
    Output,
}

struct Context(Failure);

impl TurnContextProjection for Context {
    fn project<'a>(
        &'a self,
        _: GuidedInvocation<'a>,
        _: ContextProjectionInput<'a>,
    ) -> ContextProjectionFuture<'a> {
        Box::pin(async move {
            if matches!(self.0, Failure::Context) {
                Err(ContextProjectionError::Contract(BtccError::new(
                    "context_failed",
                    "context_failed",
                )))
            } else {
                Ok(ContextProjection {
                    messages: super::ContextMessages::Transport,
                    bounded_continuation: None,
                    provider_body_admission: None,
                    requires_rebase: false,
                    recheck_steering_on_rebase: false,
                })
            }
        })
    }
}

struct OutputBudget(TurnContinuationBudgetLimits);

impl OutputBudget {
    fn new() -> Self {
        Self(TurnContinuationBudgetLimits {
            max_model_requests: 1,
            max_tool_rounds: 1,
            max_model_facing_bytes: 1,
            max_cumulative_model_facing_bytes: 1,
            max_output_bytes: 1,
            max_elapsed_ms: 1,
            max_idle_ms: 1,
            extensions: Default::default(),
        })
    }
}

impl TurnContinuationBudgetPort for OutputBudget {
    fn limits(&self) -> &TurnContinuationBudgetLimits {
        &self.0
    }
    fn admit_request<'a>(&'a self, _: &'a str, _: &'a str, _: u64) -> PortFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn record_output<'a>(&'a self, _: &'a str, _: u64) -> PortFuture<'a, ()> {
        Box::pin(async { Err(BtccError::new("output_failed", "output_failed")) })
    }
    fn record_tool_round<'a>(&'a self, _: &'a str) -> PortFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

async fn failed_round(failure: Failure, cleanup_error: bool) -> (AgentLoopError, Vec<String>) {
    let fixture = Fixture::new([result("done", vec![], 0)]);
    if matches!(failure, Failure::Provider) {
        let mut results = fixture.model_results.lock().unwrap();
        results.clear();
        results.push_back(Err(ModelRoundError::Integrity(BtccError::new(
            "provider_failed",
            "provider_failed",
        ))));
    }
    fixture.cleanup_error.store(cleanup_error, Ordering::SeqCst);
    let admitted = turn(None, "safe_fallback");
    let execution_claim = claim();
    let cancellation = tokio_util::sync::CancellationToken::new();
    let execution = fixture
        .create(ModelExecutionInput {
            source_revision: crate::btcc::model_route::GuidedSourceRevision::from_turn(&admitted),
            turn: &admitted,
            claim: &execution_claim,
            progress: fixture.as_ref(),
            model_round_observer: &crate::btcc::NOOP_MODEL_ROUND_OBSERVER,
            cancellation: cancellation.clone(),
            base: fixture.as_ref(),
        })
        .await
        .unwrap();
    let budget = if matches!(failure, Failure::Output) {
        Some(Arc::new(OutputBudget::new()) as Arc<dyn TurnContinuationBudgetPort>)
    } else {
        None
    };
    let invocation = Invocation {
        turn: &admitted,
        claim: &execution_claim,
        recovery_attempt: 1,
        progress: fixture.as_ref(),
        model_round_observer: &crate::btcc::NOOP_MODEL_ROUND_OBSERVER,
        semantic: super::contracts::SemanticTurn::parse(&admitted).unwrap(),
        cancellation,
        model: fixture.as_ref(),
        model_execution: execution.as_ref(),
        policy: fixture.as_ref(),
        operation_results: Some(fixture.as_ref()),
        budget,
        observer: Some(fixture.as_ref()),
    };
    let prepared: PreparedPolicy = fixture
        .prepare(GuidedInvocation::from(&invocation))
        .await
        .unwrap();
    let mut state = State {
        messages: vec![super::ModelRoundMessage::user("hello".into(), None)],
        tool_results: vec![],
        provider_continuation: None,
        next_item_ordinal: 0,
        model_round_index: 0,
        iteration: 0,
        empty_recovery_used: false,
        final_report: false,
        resumed_batch: None,
        resumed_call: None,
        presentation: None,
        used_tools: vec![],
        runtime_failure: None,
    };
    let mut tools = prepared.tools.clone();
    let mut digest = None;
    let error = run_model_round(
        &invocation,
        &mut state,
        &prepared,
        0,
        &mut tools,
        &mut digest,
        &Context(failure),
    )
    .await
    .unwrap_err();
    let events = fixture.events.lock().unwrap().clone();
    (error, events)
}

#[tokio::test]
async fn context_provider_and_output_failures_release_before_failure_progress() {
    for (failure, code) in [
        (Failure::Context, "context_failed"),
        (Failure::Provider, "provider_failed"),
        (Failure::Output, "output_failed"),
    ] {
        let (error, events) = failed_round(failure, false).await;
        assert!(matches!(error, AgentLoopError::Propagate(ref error) if error.code == code));
        let release = events
            .iter()
            .position(|value| value == "failed:btcc-model-round-0")
            .unwrap();
        let progress = events
            .iter()
            .position(|value| value == "progress:tool.started")
            .unwrap();
        let failed_progress = events
            .iter()
            .position(|value| value == "progress:tool.failed")
            .unwrap();
        assert!(progress < release && release < failed_progress);
    }
}

#[tokio::test]
async fn replay_cleanup_error_replaces_original_and_prevents_failure_publication() {
    let (error, events) = failed_round(Failure::Context, true).await;
    assert!(
        matches!(error, AgentLoopError::Propagate(ref error) if error.code == "cleanup_failed")
    );
    assert!(
        events
            .iter()
            .any(|value| value == "failed:btcc-model-round-0")
    );
    assert!(!events.iter().any(|value| value == "progress:tool.failed"));
}
