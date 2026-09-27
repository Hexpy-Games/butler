use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::btcc::AgentLoopError;

use super::continuation::AuthorityLoopContinuation;
use super::contracts::{
    AgentLoopEvent, AuthorityDecision, ModelRoundMessage, ModelRoundRole, SteeringObservation,
};
use super::ports::{AgentLoopObserver, propagated};
use crate::btcc::BtccCode;

pub(super) struct State {
    pub messages: Vec<ModelRoundMessage>,
    pub tool_results: Vec<super::contracts::ToolResult>,
    pub provider_continuation: Option<Value>,
    pub next_item_ordinal: u64,
    pub model_round_index: u32,
    pub iteration: u32,
    pub empty_recovery_used: bool,
    pub final_report: bool,
    pub resumed_batch: Option<super::continuation::AuthorityBatch>,
    pub resumed_call: Option<super::contracts::ModelRoundToolCall>,
    pub presentation: Option<super::continuation::GuidedPresentation>,
    pub used_tools: Vec<String>,
    pub runtime_failure: Option<crate::btcc::RuntimeFailure>,
}

pub(super) fn append_observations(state: &mut State, observations: Vec<SteeringObservation>) {
    for observation in observations {
        if observation.content.trim().is_empty() {
            continue;
        }
        if observation.request_segment_kind == "current_user_request" {
            state.final_report = false;
        }
        state.messages.push(ModelRoundMessage::user(
            observation.content,
            Some(observation.request_segment_kind),
        ));
    }
}

pub(super) fn identify_messages(messages: &mut [ModelRoundMessage], ordinal: &mut u64) {
    for message in messages {
        if message.continuation_item_id.is_none() {
            message.continuation_item_id = Some(next_item_id(ordinal));
        }
    }
}

pub(super) fn next_item_id(ordinal: &mut u64) -> String {
    let id = format!("turn-item-{ordinal}");
    *ordinal = ordinal.saturating_add(1);
    id
}

pub(super) fn identify_response(response: &mut super::contracts::ModelRoundResult, id: String) {
    let message = response.assistant_message.get_or_insert_with(|| {
        assistant_message(
            response.text.clone().unwrap_or_default(),
            response.tool_calls.clone(),
            response.raw.clone(),
        )
    });
    message.continuation_item_id = Some(id);
}

pub(super) fn assistant_message(
    content: String,
    tool_calls: Vec<super::contracts::ModelRoundToolCall>,
    provider_data: Option<Value>,
) -> ModelRoundMessage {
    ModelRoundMessage {
        role: ModelRoundRole::Assistant,
        content: content.into(),
        tool_call_id: None,
        name: None,
        tool_calls: Some(tool_calls),
        image_attachments: Vec::new(),
        provider_data,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: None,
    }
}

pub(super) fn begin_final_report(state: &mut State) {
    state.final_report = true;
    state.messages.push(ModelRoundMessage::user(
        "Execution is settled. Write the final factual report as your normal assistant response now; the runtime delivers it to the recipient automatically. No reporting tool or further tool call is needed. Include the outcome, checks performed, and any remaining work from the results already received."
            .into(),
        None,
    ));
}

pub(super) fn emit(observer: Option<&dyn AgentLoopObserver>, event: &AgentLoopEvent) {
    if let Some(observer) = observer {
        observer.event(event);
    }
}

pub(super) fn cancelled(cancellation: &CancellationToken) -> Result<(), AgentLoopError> {
    if cancellation.is_cancelled() {
        Err(propagated(super::invalid_contract(BtccCode::TurnCancelled)))
    } else {
        Ok(())
    }
}

pub(super) fn validate_decision(
    continuation: &AuthorityLoopContinuation,
    decision: &AuthorityDecision,
) -> Result<(), AgentLoopError> {
    if matches!(decision, AuthorityDecision::Modify { input } if input.trim().is_empty()) {
        return Err(propagated(super::invalid_contract(
            BtccCode::AuthorityModifyInputMissing,
        )));
    }
    if continuation.batch.next_call_index >= continuation.batch.calls.len() {
        return Err(propagated(super::invalid_contract(
            BtccCode::AuthorityContinuationCursorInvalid,
        )));
    }
    Ok(())
}
