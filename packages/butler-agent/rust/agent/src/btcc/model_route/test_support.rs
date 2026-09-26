use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::btcc::agent_loop::{
    ModelRoundError, ModelRoundMessage, ModelRoundPort, ModelRoundRequest, ModelRoundResult,
    ToolChoice,
};
use crate::btcc::{
    AgentLoopProgress, BtccError, ContinuationBudgetTransition, ModelRoundAcceptanceWrite,
    ModelRoundKey, ModelRouteEventWrite, PortFuture, ReasoningEffort, StateExecutionClaim,
    StopPersistenceOutcome, TransitionCommitError, TurnRecord, TurnSemanticState, TurnStore,
    TurnTransition,
};

#[derive(Default)]
pub(super) struct Store {
    pub(super) events: Mutex<Vec<Value>>,
    pub(super) histories: Mutex<VecDeque<Value>>,
    pub(super) accepted: Mutex<VecDeque<Option<Value>>>,
    acceptances: Mutex<Vec<Value>>,
    pub(super) fail_read: Mutex<Option<BtccError>>,
}

impl TurnStore for Store {
    fn load_or_admit(&self, _: &crate::btcc::PreparedTurn) -> PortFuture<'_, (TurnRecord, bool)> {
        panic!("not used by this test")
    }
    fn find_turn(&self, _: &str) -> PortFuture<'_, Option<TurnRecord>> {
        panic!("not used by this test")
    }
    fn resume_authority(&self, _: &str) -> PortFuture<'_, Option<TurnRecord>> {
        panic!("not used by this test")
    }
    fn acquire_state_claim(&self, _: &TurnRecord) -> PortFuture<'_, StateExecutionClaim> {
        panic!("not used by this test")
    }
    fn commit_transition(
        &self,
        _: &TurnRecord,
        _: &StateExecutionClaim,
        _: &TurnTransition,
    ) -> Pin<Box<dyn Future<Output = Result<(), TransitionCommitError>> + Send + '_>> {
        panic!("not used by this test")
    }
    fn activate_successor(&self, _: &str) -> PortFuture<'_, TurnRecord> {
        panic!("not used by this test")
    }
    fn stop(&self, _: &str) -> PortFuture<'_, StopPersistenceOutcome> {
        panic!("not used by this test")
    }
    fn record_model_route_event(
        &self,
        write: ModelRouteEventWrite,
    ) -> PortFuture<'_, Option<Value>> {
        Box::pin(async move {
            self.events.lock().unwrap().push(write.event);
            Ok(Some(json!({"status":"recorded"})))
        })
    }
    fn load_model_route_attempt_history(&self, _: ModelRoundKey) -> PortFuture<'_, Value> {
        Box::pin(async move {
            if let Some(error) = self.fail_read.lock().unwrap().take() {
                return Err(error);
            }
            Ok(self
                .histories
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| json!({"started":[],"failed":[],"succeeded":[],"abandoned":[]})))
        })
    }
    fn load_model_round_acceptance(&self, _: ModelRoundKey) -> PortFuture<'_, Option<Value>> {
        Box::pin(async move {
            if let Some(error) = self.fail_read.lock().unwrap().take() {
                return Err(error);
            }
            Ok(self.accepted.lock().unwrap().pop_front().unwrap_or(None))
        })
    }
    fn record_model_round_acceptance(
        &self,
        write: ModelRoundAcceptanceWrite,
    ) -> PortFuture<'_, ()> {
        Box::pin(async move {
            self.acceptances.lock().unwrap().push(write.result);
            Ok(())
        })
    }
    fn transition_continuation_budget(
        &self,
        _: ContinuationBudgetTransition,
    ) -> PortFuture<'_, Value> {
        panic!("not used by this test")
    }
}

pub(super) struct Base {
    results: Mutex<VecDeque<Result<ModelRoundResult, ModelRoundError>>>,
    pub(super) models: Mutex<Vec<String>>,
    pub(super) attempts: Mutex<Vec<Option<f64>>>,
}
impl Base {
    pub(super) fn new(
        results: impl IntoIterator<Item = Result<ModelRoundResult, ModelRoundError>>,
    ) -> Self {
        Self {
            results: Mutex::new(results.into_iter().collect()),
            models: Mutex::new(Vec::new()),
            attempts: Mutex::new(Vec::new()),
        }
    }
}
impl ModelRoundPort for Base {
    fn context_sizing<'a>(
        &'a self,
        _: ContextSizingRequest<'a>,
    ) -> Result<Option<ContextSizing<'a>>, ModelRoundError> {
        Ok(Some(ContextSizing {
            max_output_tokens: Some(7.5),
            max_message_bytes: 99.25,
            measure: Box::new(|messages| Ok(messages.len() as f64 * 3.5)),
        }))
    }
    fn initial_request_bytes(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<Option<usize>, ModelRoundError> {
        Ok(Some(11))
    }
    fn stateless_message_bytes(
        &self,
        messages: &[ModelRoundMessage],
        _: Option<&str>,
    ) -> Result<Option<usize>, ModelRoundError> {
        Ok(Some(messages.len() * 5))
    }
    fn run_round<'a>(
        &'a self,
        request: ModelRoundRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<ModelRoundResult, ModelRoundError>> + Send + 'a>> {
        Box::pin(async move {
            self.models.lock().unwrap().push(request.model.into());
            self.attempts
                .lock()
                .unwrap()
                .push(request.provider_retry_attempts);
            self.results
                .lock()
                .unwrap()
                .pop_front()
                .expect("model fixture result")
        })
    }
}

#[derive(Default)]
pub(super) struct Progress {
    pub(super) events: Mutex<Vec<crate::btcc::RuntimeTurnEventInput>>,
}
impl AgentLoopProgress for Progress {
    fn emit(&self, event: crate::btcc::RuntimeTurnEventInput) -> PortFuture<'_, ()> {
        Box::pin(async move {
            self.events.lock().unwrap().push(event);
            Ok(())
        })
    }
}

pub(super) async fn make_execution<'a>(
    store: Arc<Store>,
    base: &'a Base,
    turn: &'a TurnRecord,
    claim: &'a StateExecutionClaim,
    progress: &'a Progress,
    cancellation: CancellationToken,
) -> Box<dyn ModelExecution + 'a> {
    TurnModelExecutionFactory::new(store, ModelRouteRetryConfig::new(0.0))
        .create(ModelExecutionInput {
            source_revision: crate::btcc::model_route::GuidedSourceRevision::from_turn(turn),
            turn,
            claim,
            progress,
            model_round_observer: &crate::btcc::NOOP_MODEL_ROUND_OBSERVER,
            cancellation,
            base,
        })
        .await
        .unwrap()
}
pub(super) async fn run(
    execution: &dyn ModelExecution,
    round: &str,
) -> Result<ModelRoundResult, ModelRoundError> {
    let messages = [message("hello")];
    let reasoning = ReasoningEffort::High;
    execution
        .routed()
        .run_round(request(
            round,
            &messages,
            &reasoning,
            CancellationToken::new(),
        ))
        .await
}
pub(super) fn request<'a>(
    round: &'a str,
    messages: &'a [ModelRoundMessage],
    reasoning: &'a ReasoningEffort,
    cancellation: CancellationToken,
) -> ModelRoundRequest<'a> {
    ModelRoundRequest {
        max_output_tokens: None,
        round_id: Some(round),
        model: "openai/a",
        messages,
        instructions: None,
        tools: &[],
        tool_surface_digest: None,
        tool_choice: Some(ToolChoice::Auto),
        reasoning_effort: reasoning,
        cancellation,
        attachments: &[],
        image_carrier: None,
        image_capability: None,
        image_manifests: &[],
        verified_image_payload: None,
        butler_data: None,
        usage_attribution: None,
        cache_scope: None,
        stable_provider_cache_prefix: None,
        route_context: None,
        provider_retry_attempts: Some(3.0),
        route_transport_attempt_ordinal: None,
        continuation: None,
        bounded_continuation: None,
        provider_body_admission: None,
        stream_observer: None,
        identity_observer: None,
    }
}
pub(super) fn result(text: &str) -> ModelRoundResult {
    ModelRoundResult {
        text: Some(text.into()),
        tool_calls: vec![],
        text_tool_call_names: vec![],
        assistant_message: None,
        continuation: None,
        usage: None,
        provider_identity: None,
        raw: None,
        accepted_checkpoint: None,
    }
}
pub(super) fn message(content: &str) -> ModelRoundMessage {
    ModelRoundMessage {
        role: crate::btcc::agent_loop::ModelRoundRole::User,
        content: content.into(),
        tool_call_id: None,
        name: None,
        tool_calls: None,
        image_attachments: vec![],
        provider_data: None,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: None,
    }
}
pub(super) fn provider(code: &str, status: Option<u16>) -> ModelRoundError {
    ModelRoundError::Provider(Box::new(ProviderRequestError {
        code: code.into(),
        message: code.into(),
        provider: "test".into(),
        api: "test".into(),
        status_code: status,
        endpoint: None,
        model: None,
        retryable: true,
        cause: None,
        request_generation: None,
        measured_input_tokens: None,
        registered_input_capacity: None,
        request_hash: None,
        timeout_kind: None,
        retry_at: None,
        provider_request_id: None,
        rate_limit: None,
        provider_error_code: None,
        provider_error_type: None,
        provider_error_details: None,
    }))
}
pub(super) fn route(cursor: u32, retries: u32) -> Value {
    json!({"schemaVersion":"butler.model-route.v1","routeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","candidates":[{"modelRef":"openai/a","reasoningEffort":"high"},{"modelRef":"openai/b","reasoningEffort":"medium"}],"retryCeiling":retries,"catalogGeneration":"test","activeCursor":cursor,"consumedAttempts":[]})
}
pub(super) fn failed_codes(store: &Store) -> Vec<String> {
    store
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|v| v["type"] == "model.attempt.failed")
        .map(|v| v["errorCode"].as_str().unwrap().into())
        .collect()
}
pub(super) fn claim() -> StateExecutionClaim {
    StateExecutionClaim {
        claim_id: "claim".into(),
        turn_id: "turn".into(),
        turn_revision: 0,
        semantic_state: TurnSemanticState::Admitted,
        checkpoint_id: "checkpoint".into(),
        checkpoint_revision: 0,
        execution_fence: 0,
    }
}
pub(super) fn turn(model_route: Value) -> TurnRecord {
    TurnRecord {
        turn_id: "turn".into(),
        session_id: "session".into(),
        inbox_id: "inbox".into(),
        trigger_key: "trigger".into(),
        original_message_id: "message".into(),
        original_message: "hello".into(),
        wake_identity: None,
        model_selection: json!({"provider":"openai","model":"a","reasoningEffort":"high","controls":{},"controlsHash":"hash"}),
        model_route: Some(model_route),
        continuation_budget: None,
        context: json!({"userRef":"user","profileRefs":[],"recentFeedbackRefs":[],"mandatoryHotCacheRefs":[],"optionalHotCacheRefs":[],"baselineObservationScopeRefs":[]}),
        progress_destination: None,
        semantic_state: TurnSemanticState::Admitted,
        suspension: None,
        authority_continuation: None,
        checkpoint: None,
        route: None,
        final_payload: None,
        delivery_outbox: None,
        canonical_assistant_message_id: None,
        revision: 0,
        execution_fence: 0,
        final_disposition: None,
    }
}
