//! Worker delegation input and parent Work-stream linkage.
use super::{GuidedTools, encoded};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{
    BtccError, GuidedInvocation, ModelRoundToolCall, ToolExecutionError, WorkerDelegationRequest,
};
use serde_json::Value;

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let acceptance = acceptance(call)?;
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
        .delegate_worker(
            request(owner, &invocation, call, call_id, acceptance)?,
            &reviewed,
        )
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

fn request(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
    acceptance: Vec<String>,
) -> Result<WorkerDelegationRequest, ToolExecutionError> {
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
    Ok(WorkerDelegationRequest {
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
        access_mode: owner.binding.access_mode.clone(),
        schedule_run: owner.inherited_run(),
    })
}

fn acceptance(call: &ModelRoundToolCall) -> Result<Vec<String>, ToolExecutionError> {
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
    Ok(acceptance)
}
