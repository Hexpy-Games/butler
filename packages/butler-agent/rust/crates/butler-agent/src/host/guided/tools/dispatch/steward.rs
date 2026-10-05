//! Reviewed Steward delegation and its WorkStream link.
use super::{GuidedTools, access_mode, encoded};
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
    let reviewed = owner
        .work
        .bound_work()
        .await
        .map_err(ToolExecutionError::Integrity)?
        .ok_or_else(|| {
            ToolExecutionError::Integrity(BtccError::relayed(
                "delegation_reviewed_plan_required",
                "Reviewed parent Work is required",
            ))
        })?;
    let result = owner
        .subsessions
        .delegate_steward(
            butler_turn::btcc::StewardDelegationRequest {
                parent_session_id: owner.binding.source_session_id.clone(),
                parent_turn_id: owner.binding.turn_id.clone(),
                anchor_message_id: invocation.turn.original_message_id.clone(),
                request: request.to_owned(),
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
            },
            &reviewed,
        )
        .await
        .map_err(ToolExecutionError::Integrity)?;
    link_orchestration(owner, &result).await?;
    encoded(&result)
}

async fn link_orchestration(owner: &GuidedTools, result: &Value) -> Result<(), ToolExecutionError> {
    if let Some(relation_id) = result.get("relation_id").and_then(Value::as_str) {
        owner
            .work_streams
            .link_orchestration(
                crate::host::guided::work_streams::WorkStreamScope {
                    session_id: owner.binding.source_session_id.clone(),
                    origin_chat_id: None,
                    project_id: owner.binding.memory.project_id.clone(),
                    turn_id: owner.binding.turn_id.clone(),
                },
                relation_id.to_owned(),
            )
            .await
            .map_err(ToolExecutionError::Integrity)?;
    }
    Ok(())
}
