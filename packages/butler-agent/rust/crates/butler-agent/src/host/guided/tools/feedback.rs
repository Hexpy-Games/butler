//! Model-correctable refusals are durable tool results, never runtime interrupts.
//! Keep an explicit allowlist: storage, journal and identity corruption still fail closed.

use butler_core::json::JsonDocument;
use butler_turn::btcc::{BtccError, ToolExecutionError};
use serde_json::json;

pub(super) fn solvable(code: &str) -> bool {
    SOLVABLE.contains(&code)
}

pub(super) const SOLVABLE: &[&str] = &[
    "schedule_access_exceeds_turn",
    "delegation_reviewed_plan_required",
    "delegation_allowed_effects_required",
    "delegation_mutation_scope_required",
    "steward_delegation_input_invalid",
    "worker_delegation_input_invalid",
    "steward_delegation_plan_mode_required",
    "worker_delegation_plan_mode_required",
    "worker_plan_action_missing",
    "worker_plan_action_not_executable",
    "worker_plan_action_dependency_incomplete",
    "worker_profile_missing",
    "worker_profile_unavailable",
    "parent_app_binding_required",
    "parent_butler_session_required",
    "parent_steward_session_required",
    "parent_steward_context_required",
    "active_steward_relation_ambiguous",
    "active_steward_relation_not_found",
    "steward_relation_not_found",
    "steward_relation_not_active",
    "steward_relation_not_recoverable",
    "steward_direction_identity_conflict",
    "steward_direction_instruction_required",
    "steward_direction_instruction_too_long",
    "steward_followup_authority_mismatch",
    "steward_project_binding_missing",
    "subsession_access_mode_invalid",
    "subsession_effect_not_allowed",
    "subsession_mutation_scope_invalid",
    "subsession_mutation_scope_wildcard_not_allowed",
    "durable_work_policy",
    "durable_work_validation",
    "durable_work_open_missing",
    "durable_work_plan_missing",
    "durable_work_stage_missing",
    "durable_work_terminal_relation",
    "invalid_work_stage_transition",
    "work_transition_guard_unmet",
    "todo_items_invalid",
    "todo_item_invalid",
    "todo_item_duplicate",
    "todo_status_invalid",
    "todo_multiple_active",
    "work_stream_input_invalid",
    "work_stream_contract_authorization_required",
    "work_stream_terminal_immutable",
    "work_stream_not_found",
    "work_stream_state_invalid",
    "work_stream_transition_invalid",
    "work_stream_id_invalid",
    "work_stream_path_invalid",
    "image_attachment_not_authorized",
    "image_analysis_requires_full_access",
    "image_file_id_required",
    "image_prompt_required",
    "image_prompt_too_long",
    "image_derivative_mime_unsupported",
    "zai_vision_carrier_unverified",
    "zai_vision_carrier_changed",
    "image_payload_invalid",
    "mcp_server_unavailable",
    "guided_tool_executor_missing",
    "artifact_not_found",
    "artifact_reference_required",
    "artifact_scan_limit_exceeded",
    "unsafe_artifact_path",
    "invalid_arguments",
    "question_input_invalid",
    "effect_request_invalid",
];

pub(super) fn result(error: &BtccError) -> Result<JsonDocument, ToolExecutionError> {
    let message = match error.code() {
        "delegation_reviewed_plan_required" => {
            "Create or continue parent Work, record a Plan with execution_mode steward or workers, and record an accepting Plan Review bound to that current Plan revision. Then retry delegation. No delegation was started."
        }
        "steward_delegation_plan_mode_required" => {
            "Revise the current Plan to execution_mode steward and record an accepting Plan Review before retrying."
        }
        "worker_delegation_plan_mode_required" => {
            "Revise the current Plan to execution_mode workers and record an accepting Plan Review before retrying."
        }
        "todo_multiple_active" => {
            "Only one todo may be in_progress. Set the other todos to pending, completed or cancelled, then retry."
        }
        "todo_item_duplicate" => {
            "Each todo requires a unique id. Correct the duplicate ids, then retry."
        }
        "steward_relation_not_found" | "active_steward_relation_not_found" => {
            "Check the exact relation_id and current delegation state. For a new request after the previous Work closed, start and review a fresh Work, then delegate_to_steward with previous_relation_id in this same turn. Do not ask the user to restart. No child was steered or cancelled."
        }
        _ => error.message(),
    };
    let mut value = json!({"ok":false,"error":{
        "code":error.code(),"message":message,"recoverable":true,
        "next_action":"Inspect the current Work, Plan execution_mode, action status and dependency results in context. Correct the named field using the tool schema (or describe_tools for a discovered tool). Resolve pending dependencies first; choose a permitted action or revise the Plan before retrying. Wait for an active child through the existing delegation flow, using wait_for_worker when it is available. Ask the user only for an input or decision that they alone can provide."
    }});
    if error.code().starts_with("effect_") {
        value["error"]["next_action"] = repair(error.code()).into();
    }
    JsonDocument::from_value(&value).map_err(|source| {
        ToolExecutionError::Integrity(
            BtccError::relayed(
                "guided_tool_result_json",
                "Tool feedback could not be encoded",
            )
            .with_source(source),
        )
    })
}

/// Include the live state needed to repair a refusal, using the existing indexed Work lookup.
pub(super) async fn contextual_result(
    owner: &super::GuidedTools,
    error: &BtccError,
) -> Result<JsonDocument, ToolExecutionError> {
    let receipt = result(error)?;
    let mut value: serde_json::Value =
        serde_json::from_str(receipt.as_str()).map_err(|source| {
            ToolExecutionError::Integrity(
                BtccError::relayed("guided_tool_result_json", "Invalid tool feedback")
                    .with_source(source),
            )
        })?;
    let work = owner
        .work
        .bound_work()
        .await
        .map_err(ToolExecutionError::Integrity)?;
    value["current_state"] = json!({
        "access_mode":owner.binding.access_mode,
        "work_id":work.as_ref().map(|work| &work.work_id),
        "work_status":work.as_ref().map(|work| work.status),
        "execution_mode":work.as_ref().and_then(|work| work.current_plan.as_ref()).and_then(|plan| plan.execution_mode),
        "action_progress":work.as_ref().map(|work| &work.action_progress),
        "dependencies":work.as_ref().and_then(|work| work.current_plan.as_ref()).map(|plan|
            plan.actions.iter().map(|action| json!({"action_key":action.action_key,"dependency_keys":action.dependency_keys})).collect::<Vec<_>>()),
        "available_tools":owner.binding.surface.iter().map(|tool| &tool.name).collect::<Vec<_>>()
    });
    super::dispatch::encoded(&value)
}

/// Invalid adapter input is corrected in place, independently of Work tracking.
pub(super) fn repair(code: &str) -> &'static str {
    if code == "schedule_access_exceeds_turn" {
        return "Omit access_mode to use this conversation's access.";
    }
    "Correct the tool arguments using the returned error and tool schema, then retry the exact operation in this turn. Permission mode and operation approval govern execution; no Work or Plan effect declaration is required."
}
