use serde_json::Value;
use std::collections::BTreeMap;
use tokio_util::sync::CancellationToken;

use crate::btcc::AgentLoopError;

use super::continuation::{AuthorityBatch, AuthorityLoopContinuation, GuidedPresentation};
use super::contracts::{
    AgentLoopEvent, AuthorityDecision, LoopPhase, ModelRoundMessage, ModelRoundRole,
    ModelRoundToolCall, PreparedPolicy, SteeringObservation, ToolResult,
};
use super::ports::{AgentLoopObserver, propagated};
use crate::btcc::BtccCode;

/// The request segment a steering message opens when the user adds a new request.
pub(super) const CURRENT_USER_REQUEST: &str = "current_user_request";

/// The mutable transcript and bookkeeping of one agent-loop execution.
pub(super) struct State {
    pub messages: Vec<ModelRoundMessage>,
    pub tool_results: Vec<ToolResult>,
    /// Provider continuation handle echoed on the next request (passthrough JSON).
    pub provider_continuation: Option<Value>,
    pub next_item_ordinal: u64,
    pub model_round_index: u32,
    pub iteration: u32,
    pub empty_recovery_used: bool,
    pub automatic_continuations: u32,
    pub stop_hook_active: bool,
    // Independent of projected messages, so compaction never resets repetition facts.
    pub feedback_counts: BTreeMap<String, u64>,
    pub phase: LoopPhase,
    pub resumed_batch: Option<AuthorityBatch>,
    pub resumed_call: Option<ModelRoundToolCall>,
    pub presentation: Option<GuidedPresentation>,
    pub used_tools: Vec<String>,
    pub runtime_failure: Option<crate::btcc::RuntimeFailure>,
}

impl State {
    /// A fresh execution: the rendered prompt becomes the first transcript item.
    pub(super) fn fresh(prepared: &mut PreparedPolicy) -> Self {
        let mut prompt = ModelRoundMessage::user(std::mem::take(&mut prepared.prompt), None);
        prompt.continuation_item_id = Some("turn-item-0".into());
        Self {
            messages: vec![prompt],
            tool_results: Vec::new(),
            provider_continuation: None,
            next_item_ordinal: 1,
            model_round_index: 0,
            iteration: 0,
            empty_recovery_used: false,
            automatic_continuations: 0,
            stop_hook_active: false,
            feedback_counts: BTreeMap::new(),
            phase: LoopPhase::Working,
            resumed_batch: None,
            resumed_call: prepared.resumed_tool_call.take(),
            presentation: None,
            used_tools: Vec::new(),
            runtime_failure: None,
        }
    }

    /// Resumes a suspended execution from its authority continuation.
    ///
    /// The continuation's instructions and stable cache prefix replace the
    /// freshly rendered ones so the resumed request matches the suspended one.
    pub(super) fn resumed(
        restored: AuthorityLoopContinuation,
        prepared: &mut PreparedPolicy,
    ) -> Self {
        drop(std::mem::take(&mut prepared.prompt));
        prepared.instructions = restored.instructions;
        prepared.request.stable_provider_cache_prefix = restored.stable_provider_cache_prefix;
        let used_tools = restored
            .tool_results
            .iter()
            .map(|result| result.name.clone())
            .collect();
        Self {
            messages: restored.messages,
            tool_results: restored.tool_results,
            provider_continuation: restored.provider_continuation,
            next_item_ordinal: restored.next_item_ordinal,
            model_round_index: restored.model_round_index,
            iteration: restored.iteration,
            empty_recovery_used: restored.empty_response_recovery_used,
            automatic_continuations: restored.automatic_continuations,
            stop_hook_active: restored.stop_hook_active,
            feedback_counts: restored.feedback_counts,
            phase: LoopPhase::Working,
            resumed_batch: Some(restored.batch),
            resumed_call: prepared.resumed_tool_call.take(),
            presentation: restored.presentation,
            used_tools,
            runtime_failure: None,
        }
    }

    pub(super) fn feedback(&mut self, observation: &str) -> String {
        self.feedback_for(observation, observation)
    }

    pub(super) fn feedback_for(&mut self, identity: &str, observation: &str) -> String {
        let key = crate::btcc::digest_identity(identity);
        let count = self.feedback_counts.entry(key).or_default();
        *count = count.saturating_add(1);
        format!(
            "{observation}\nThis identical feedback has occurred {count} times in this execution. Try a different approach if the previous one failed."
        )
    }

    /// Starts the next iteration and returns the index of the one starting.
    pub(super) fn begin_iteration(&mut self) -> u32 {
        let iteration = self.iteration;
        self.iteration = self.iteration.saturating_add(1);
        iteration
    }

    /// Whether this iteration replays a suspended batch or an accepted call
    /// instead of asking the model.
    pub(super) fn is_replaying(&self, resumed_batch: Option<&AuthorityBatch>) -> bool {
        resumed_batch.is_some() || self.resumed_call.is_some()
    }
}

pub(super) fn append_observations(state: &mut State, observations: Vec<SteeringObservation>) {
    for observation in observations {
        if observation.content.trim().is_empty() {
            continue;
        }
        if observation.request_segment_kind == CURRENT_USER_REQUEST {
            state.phase = LoopPhase::Working;
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

pub(super) fn identify_response(
    response: &mut super::contracts::ModelRoundResult,
    id: String,
) -> Option<u64> {
    let message = response.assistant_message.get_or_insert_with(|| {
        assistant_message(
            response.text.clone().unwrap_or_default(),
            response.tool_calls.clone(),
            response.raw.clone(),
        )
    });
    // An accepted replay keeps its original transcript identity. Recovery can
    // render fewer steering observations than the original execution.
    message
        .continuation_item_id
        .get_or_insert(id)
        .strip_prefix("turn-item-")
        .and_then(|value| value.parse::<u64>().ok())
}

// Passthrough: provider payload, opaque to BTCC.
pub(super) fn assistant_message(
    content: String,
    tool_calls: Vec<ModelRoundToolCall>,
    // Passthrough: provider payload, opaque to BTCC.
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
    state.phase = LoopPhase::FinalReport;
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
