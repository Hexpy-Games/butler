//! Reviewed Steward delegation and its WorkStream link.
use super::{GuidedTools, ToolName, access_mode, encoded};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{BtccError, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::Value;
pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let request = call
        .arguments
        .get("request")
        .and_then(Value::as_str)
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ToolExecutionError::Integrity(BtccError::relayed(
                "steward_delegation_input_invalid",
                "request is required",
            ))
        })?;
    let result = owner
        .subsessions
        .delegate_steward(butler_turn::btcc::StewardDelegationRequest {
            parent_session_id: owner.binding.source_session_id.clone(),
            parent_turn_id: owner.binding.turn_id.clone(),
            anchor_message_id: invocation.turn.original_message_id.clone(),
            request: request.to_owned(),
            part_id: call
                .arguments
                .get("part_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            previous_relation_id: call
                .arguments
                .get("previous_relation_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            safe_title: call
                .arguments
                .get("safe_title")
                .and_then(Value::as_str)
                .map(str::to_owned),
            model_ref: owner.binding.model_ref.clone(),
            reasoning_effort: owner.binding.reasoning_effort.clone(),
            access_mode: access_mode(owner),
            schedule_run: owner.unattended_run(),
        })
        .await
        .map_err(ToolExecutionError::Integrity)?;
    encoded(&result)
}

pub(super) async fn steer(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let instruction = call
        .arguments
        .get("instruction")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ToolExecutionError::Integrity(BtccError::relayed(
                "steward_direction_instruction_required",
                "instruction is required",
            ))
        })?;
    let result = owner
        .subsessions
        .steer(butler_turn::btcc::SubsessionDirectionRequest {
            parent_session_id: owner.binding.source_session_id.clone(),
            parent_turn_id: owner.binding.turn_id.clone(),
            source_message_id: invocation.turn.original_message_id.clone(),
            relation_id: call
                .arguments
                .get("relation_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            work_id: call
                .arguments
                .get("work_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            safe_title: call
                .arguments
                .get("safe_title")
                .and_then(Value::as_str)
                .map(str::to_owned),
            instruction: instruction.into(),
            child_role: if call.name == ToolName::SteerWorker {
                butler_turn::workspace::SessionRole::Worker
            } else {
                butler_turn::workspace::SessionRole::Steward
            },
            access_mode: access_mode(owner),
        })
        .await
        .map_err(ToolExecutionError::Integrity)?;
    encoded(&result)
}

/// Cancels this turn's Steward conversation.
pub(super) async fn cancel(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let text = |key: &str| {
        call.arguments
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let result = owner
        .subsessions
        .cancel(butler_turn::btcc::SubsessionCancelRequest {
            parent_session_id: owner.binding.source_session_id.clone(),
            parent_turn_id: owner.binding.turn_id.clone(),
            source_message_id: invocation.turn.original_message_id.clone(),
            relation_id: text("relation_id"),
            safe_title: text("safe_title"),
            child_role: butler_turn::workspace::SessionRole::Steward,
        })
        .await
        .map_err(ToolExecutionError::Integrity)?;
    encoded(&result)
}
