use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::btcc::{AgentLoop, StateExecutionClaim, TurnRecord};
use crate::btcc::{AgentLoopProgress, PortFuture, RuntimeTurnEventInput};

use super::ProductionAgentLoop;
use super::contracts::{AcceptedCheckpoint, ModelRoundResult, ModelRoundTool, ModelRoundToolCall};

pub(super) fn result(text: &str, calls: Vec<ModelRoundToolCall>, round: u32) -> ModelRoundResult {
    ModelRoundResult {
        text: Some(text.into()),
        tool_calls: calls,
        text_tool_call_names: vec![],
        assistant_message: None,
        continuation: None,
        usage: None,
        provider_identity: None,
        raw: None,
        accepted_checkpoint: Some(AcceptedCheckpoint {
            round_id: format!("btcc-model-round-{round}"),
            candidate_index: 0,
            transport_attempt: 1,
            model_ref: "openai/model".into(),
        }),
    }
}

pub(super) fn call(id: &str, name: &str) -> ModelRoundToolCall {
    ModelRoundToolCall {
        id: id.into(),
        name: name.into(),
        arguments: Default::default(),
        raw_arguments: "{}".into(),
        origin: None,
    }
}

pub(super) fn tool(name: &str, concurrent: bool) -> ModelRoundTool {
    ModelRoundTool {
        name: name.into(),
        description: name.into(),
        parameters: Default::default(),
        concurrency_safe: Some(concurrent),
        tool_contract_version: Some(2),
    }
}

pub(super) fn turn(authority: Option<Value>, empty: &str) -> TurnRecord {
    TurnRecord {
        turn_id: "turn-1".into(),
        session_id: "session-1".into(),
        inbox_id: "inbox".into(),
        trigger_key: "trigger".into(),
        original_message_id: "message".into(),
        original_message: "hello".into(),
        wake_identity: None,
        model_selection: json!({"provider":"openai","model":"model","reasoningEffort":"medium","controls":{},"controlsHash":"hash"}),
        model_route: None,
        continuation_budget: None,
        context: json!({"userRef":"user-1","profileRefs":[],"recentFeedbackRefs":[],"mandatoryHotCacheRefs":[],"optionalHotCacheRefs":[],"baselineObservationScopeRefs":[],"emptyResponsePolicy": empty}),
        progress_destination: None,
        semantic_state: crate::btcc::TurnSemanticState::Admitted,
        suspension: None,
        authority_continuation: authority,
        checkpoint: None,
        route: None,
        final_payload: None,
        delivery_outbox: None,
        canonical_assistant_message_id: None,
        revision: 1,
        execution_fence: 1,
        final_disposition: None,
    }
}

pub(super) fn claim() -> StateExecutionClaim {
    StateExecutionClaim {
        claim_id: "claim".into(),
        turn_id: "turn-1".into(),
        turn_revision: 1,
        semantic_state: crate::btcc::TurnSemanticState::Admitted,
        checkpoint_id: "checkpoint".into(),
        checkpoint_revision: 1,
        execution_fence: 1,
    }
}

pub(super) async fn run(
    agent: &ProductionAgentLoop,
    turn: &TurnRecord,
) -> Result<crate::btcc::AgentLoopResult, crate::btcc::AgentLoopError> {
    agent
        .run(
            turn,
            &claim(),
            1,
            &TestProgress,
            &crate::btcc::NOOP_MODEL_ROUND_OBSERVER,
            CancellationToken::new(),
        )
        .await
}

pub(super) struct TestProgress;

impl AgentLoopProgress for TestProgress {
    fn emit(&self, _: RuntimeTurnEventInput) -> PortFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}
