//! Existing child orchestration, with canonical Task assignment in opt-in mode.
use super::super::GuidedTools;
use super::*;

pub(super) async fn delegate(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    if owner.work.managed()
        && matches!(
            call.name.as_str(),
            "delegate_to_steward" | "delegate_to_worker"
        )
    {
        let result = owner
            .subsessions
            .delegate_managed(butler_turn::btcc::ManagedDelegation {
                session: owner.binding.source_session_id.clone(),
                turn: owner.binding.turn_id.clone(),
                call: call_id.into(),
                message: invocation.turn.original_message_id.clone(),
                model_ref: owner.binding.model_ref.clone(),
                reasoning_effort: owner.binding.reasoning_effort.clone(),
                access_mode: access_mode(owner),
                worker: call.name == "delegate_to_worker",
            })
            .await
            .map_err(ToolExecutionError::Integrity)?;
        return encoded(&result);
    }
    if call.name == ToolName::DelegateToSteward {
        steward(owner, invocation, call).await
    } else {
        worker(owner, invocation, call, call_id).await
    }
}

async fn steward(
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
    encoded(&result)
}

async fn worker(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
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
        .delegate_worker(worker_request(owner, invocation, call, call_id)?, &reviewed)
        .await
        .map_err(ToolExecutionError::Integrity)?;
    if let Some(task_id) = result.get("task_id").and_then(Value::as_str) {
        owner
            .work_streams
            .link_worker(
                crate::host::guided::work_streams::WorkStreamScope {
                    session_id: owner.binding.source_session_id.clone(),
                    origin_chat_id: None,
                    project_id: owner.binding.memory.project_id.clone(),
                    turn_id: owner.binding.turn_id.clone(),
                },
                task_id.to_owned(),
            )
            .await
            .map_err(ToolExecutionError::Integrity)?;
    }
    encoded(&result)
}

fn worker_request(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<butler_turn::btcc::WorkerDelegationRequest, ToolExecutionError> {
    let required = |key: &str| {
        call.arguments
            .get(key)
            .and_then(Value::as_str)
            .map(butler_core::public_text::trim_js_whitespace)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| {
                ToolExecutionError::Integrity(BtccError::relayed(
                    "worker_delegation_input_invalid",
                    format!("{key} is required"),
                ))
            })
    };
    let acceptance = call
        .arguments
        .get("acceptance_criteria")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ToolExecutionError::Integrity(BtccError::relayed(
                "worker_delegation_input_invalid",
                "acceptance_criteria is required",
            ))
        })?
        .iter()
        .map(|v| {
            v.as_str().map(str::to_owned).ok_or_else(|| {
                ToolExecutionError::Integrity(BtccError::relayed(
                    "worker_delegation_input_invalid",
                    "acceptance_criteria is invalid",
                ))
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if acceptance.len() > 8 {
        return Err(ToolExecutionError::Integrity(BtccError::relayed(
            "worker_delegation_input_invalid",
            "acceptance_criteria is too large",
        )));
    }
    Ok(butler_turn::btcc::WorkerDelegationRequest {
        parent_session_id: owner.binding.source_session_id.clone(),
        parent_turn_id: owner.binding.turn_id.clone(),
        anchor_message_id: invocation.turn.original_message_id.clone(),
        source_tool_call_id: call_id.into(),
        action_key: required("action_key")?,
        objective: required("objective")?,
        acceptance_criteria: acceptance,
        implementation_brief: required("implementation_brief")?,
        safe_title: call
            .arguments
            .get("safe_title")
            .and_then(Value::as_str)
            .map(str::to_owned),
        profile_id: call
            .arguments
            .get("profile_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        access_mode: access_mode(owner),
    })
}
