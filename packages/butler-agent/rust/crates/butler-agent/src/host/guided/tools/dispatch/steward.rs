//! One-call Steward handoff and its WorkStream link.
use super::{GuidedTools, ToolName, access_mode, encoded};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{BtccError, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};
pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    if call.name == ToolName::ReadPriorDelegation {
        return read_prior_delegation(owner).await;
    }
    let HandoffInput {
        request,
        checks,
        epic_ref,
    } = input(call)?;
    let result = owner
        .subsessions
        .handoff_steward(
            butler_turn::btcc::StewardDelegationRequest {
                parent_session_id: owner.binding.source_session_id.clone(),
                parent_turn_id: owner.binding.turn_id.clone(),
                anchor_message_id: invocation.turn.original_message_id.clone(),
                request,
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
                access_mode: owner.binding.access_mode.clone(),
                schedule_run: owner.inherited_run(),
            },
            owner.work.scope(),
            call_id.to_owned(),
            checks,
            epic_ref,
        )
        .await
        .map_err(ToolExecutionError::Integrity)?;
    link_orchestration(owner, &result).await?;
    encoded(&result)
}

struct HandoffInput {
    request: String,
    checks: Option<Vec<String>>,
    epic_ref: Option<String>,
}

fn input(call: &ModelRoundToolCall) -> Result<HandoffInput, ToolExecutionError> {
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
    let checks: Option<Vec<String>> = call
        .arguments
        .get("checks")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| {
            ToolExecutionError::Integrity(BtccError::relayed(
                "steward_delegation_input_invalid",
                "checks must be an array of strings",
            ))
        })?;
    let epic_ref = call
        .arguments
        .get("epic_ref")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if checks.as_ref().is_some_and(|checks| checks.len() > 8)
        || call
            .arguments
            .get("epic_ref")
            .is_some_and(|value| !value.is_string())
        || epic_ref
            .as_ref()
            .is_some_and(|epic| !epic.starts_with("canon:epic/"))
    {
        return Err(ToolExecutionError::Integrity(BtccError::relayed(
            "steward_delegation_input_invalid",
            "checks accepts at most eight strings; epic_ref must name a canon epic",
        )));
    }
    Ok(HandoffInput {
        request: request.to_owned(),
        checks,
        epic_ref,
    })
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
            schedule_run: owner.inherited_run(),
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

/// Returns the complete prior delegation on demand.
async fn read_prior_delegation(owner: &GuidedTools) -> Result<JsonDocument, ToolExecutionError> {
    let prior = owner
        .subsessions
        .prior_delegation(&owner.binding.source_session_id)
        .await
        .map_err(ToolExecutionError::Integrity)?;
    encoded(&match prior {
        Some(prior) => json!({"ok":true,"prior_delegation":
            serde_json::from_str::<Value>(&prior).unwrap_or(Value::String(prior))}),
        None => json!({"ok":true,"prior_delegation":null}),
    })
}
