//! Invoke the concrete domain owner; the caller owns occurrence and result journaling.

mod mcp;
mod publication;
mod web;
pub(super) use publication::publish_work_result;

use serde_json::{Value, json};

use crate::btcc::{BtccError, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use crate::capabilities::CapabilityInvocation;
use crate::json::JsonDocument;

use super::NativeGuidedTools;
use crate::host::NativeGuidedWorkTools;

pub(super) async fn execute(
    owner: &NativeGuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    if super::image::supports(&call.name) {
        return Box::pin(super::image::execute(owner, invocation, call)).await;
    }
    if super::memory_write::supports(&call.name) {
        return super::memory_write::execute(owner, invocation, call, call_id);
    }
    if web::supports(&call.name) {
        return web::execute(owner, invocation, call).await;
    }
    if matches!(
        call.name.as_str(),
        "tool_search" | "tool_describe" | "tool_call"
    ) {
        return Box::pin(super::discovery::execute(owner, invocation, call, call_id)).await;
    }
    if call.name == "call_mcp_tool" {
        return super::effect::execute(owner, invocation, call, call_id).await;
    }
    if super::profile::supports(&call.name) {
        return super::profile::execute(owner, call).await;
    }
    if super::monitoring::supports(&call.name) {
        return super::monitoring::execute(owner, call).await;
    }
    if call.name == "read_project_source" {
        return super::project_source::execute(owner, call).await;
    }
    if mcp::supports(&call.name) {
        return Box::pin(mcp::execute(owner, invocation, call)).await;
    }
    if call.name == "delegate_to_steward" {
        let request = call
            .arguments
            .get("request")
            .and_then(Value::as_str)
            .map(crate::public_text::trim_js_whitespace)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ToolExecutionError::Integrity(BtccError::new(
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
                ToolExecutionError::Integrity(BtccError::new(
                    "delegation_reviewed_plan_required",
                    "Reviewed parent Work is required",
                ))
            })?;
        let result = owner
            .subsessions
            .delegate_steward(
                crate::btcc::StewardDelegationRequest {
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
                    access_mode: match owner.binding.access_mode {
                        crate::btcc::AccessMode::FullAccess => "full_access",
                        crate::btcc::AccessMode::AskFirst => "ask_first",
                        crate::btcc::AccessMode::ReadOnly => "read_only",
                    }
                    .into(),
                },
                &reviewed,
            )
            .await
            .map_err(ToolExecutionError::Integrity)?;
        if let Some(relation_id) = result.get("relation_id").and_then(Value::as_str) {
            owner
                .work_streams
                .link_orchestration(
                    crate::host::work_streams::WorkStreamScope {
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
        return encoded(&result);
    }
    if call.name == "list_automations" {
        let result = owner
            .automations
            .execute(
                &call.name,
                call.arguments.clone(),
                &owner.binding.source_session_id,
            )
            .await;
        return encoded(&result.unwrap_or_else(|error| {
            json!({"ok":false,"error":{
                "code":"tool_error",
                "message":format!("{} could not complete: {}", call.name, error.code),
            }})
        }));
    }
    if call.name == "delegate_to_worker" {
        let required = |key: &str| {
            call.arguments
                .get(key)
                .and_then(Value::as_str)
                .map(crate::public_text::trim_js_whitespace)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    ToolExecutionError::Integrity(BtccError::new(
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
                ToolExecutionError::Integrity(BtccError::new(
                    "worker_delegation_input_invalid",
                    "acceptance_criteria is required",
                ))
            })?
            .iter()
            .map(|v| {
                v.as_str().map(str::to_owned).ok_or_else(|| {
                    ToolExecutionError::Integrity(BtccError::new(
                        "worker_delegation_input_invalid",
                        "acceptance_criteria is invalid",
                    ))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if acceptance.len() > 8 {
            return Err(ToolExecutionError::Integrity(BtccError::new(
                "worker_delegation_input_invalid",
                "acceptance_criteria is too large",
            )));
        }
        let reviewed = owner
            .work
            .bound_work()
            .await
            .map_err(ToolExecutionError::Integrity)?
            .ok_or_else(|| {
                ToolExecutionError::Integrity(BtccError::new(
                    "delegation_reviewed_plan_required",
                    "Reviewed parent Work is required",
                ))
            })?;
        let result = owner
            .subsessions
            .delegate_worker(
                crate::btcc::WorkerDelegationRequest {
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
                    access_mode: match owner.binding.access_mode {
                        crate::btcc::AccessMode::FullAccess => "full_access",
                        crate::btcc::AccessMode::AskFirst => "ask_first",
                        crate::btcc::AccessMode::ReadOnly => "read_only",
                    }
                    .into(),
                },
                &reviewed,
            )
            .await
            .map_err(ToolExecutionError::Integrity)?;
        if let Some(task_id) = result.get("task_id").and_then(Value::as_str) {
            owner
                .work_streams
                .link_worker(
                    crate::host::work_streams::WorkStreamScope {
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
        return encoded(&result);
    }
    if matches!(call.name.as_str(), "steer_steward" | "steer_worker") {
        let instruction = call
            .arguments
            .get("instruction")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ToolExecutionError::Integrity(BtccError::new(
                    "steward_direction_instruction_required",
                    "instruction is required",
                ))
            })?;
        let result = owner
            .subsessions
            .steer(crate::btcc::SubsessionDirectionRequest {
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
                child_role: if call.name == "steer_worker" {
                    crate::workspace::SessionRole::Worker
                } else {
                    crate::workspace::SessionRole::Steward
                },
                access_mode: match owner.binding.access_mode {
                    crate::btcc::AccessMode::FullAccess => "full_access",
                    crate::btcc::AccessMode::AskFirst => "ask_first",
                    crate::btcc::AccessMode::ReadOnly => "read_only",
                }
                .into(),
            })
            .await
            .map_err(ToolExecutionError::Integrity)?;
        return encoded(&result);
    }
    if call.name == "cancel_steward" {
        let result = owner
            .subsessions
            .cancel(crate::btcc::SubsessionCancelRequest {
                parent_session_id: owner.binding.source_session_id.clone(),
                parent_turn_id: owner.binding.turn_id.clone(),
                source_message_id: invocation.turn.original_message_id.clone(),
                relation_id: call
                    .arguments
                    .get("relation_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                safe_title: call
                    .arguments
                    .get("safe_title")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                child_role: crate::workspace::SessionRole::Steward,
            })
            .await
            .map_err(ToolExecutionError::Integrity)?;
        return encoded(&result);
    }
    if call.name == "wait_for_worker" {
        let waiting = owner
            .subsessions
            .should_wait_for_child(&owner.binding.source_session_id)
            .await
            .map_err(ToolExecutionError::Integrity)?;
        return encoded(&json!({"ok":true,"status":if waiting{"waiting"}else{"no_active_worker"}}));
    }
    if NativeGuidedWorkTools::is_work_tool(&call.name) {
        return encoded(&execute_work(owner, call, call_id).await?);
    }
    if matches!(
        call.name.as_str(),
        "update_todo_list" | "list_todo_list" | "list_work_streams" | "update_work_stream_state"
    ) {
        let result = owner
            .work_streams
            .execute(
                &call.name,
                crate::host::work_streams::WorkStreamScope {
                    session_id: owner.binding.source_session_id.clone(),
                    origin_chat_id: None,
                    project_id: owner.binding.memory.project_id.clone(),
                    turn_id: owner.binding.turn_id.clone(),
                },
                Value::Object(call.arguments.clone()),
            )
            .await
            .map_err(ToolExecutionError::Integrity)?;
        return encoded(&result);
    }
    if matches!(
        call.name.as_str(),
        "run_command"
            | "write_file"
            | "edit_file"
            | "bind_session_git_worktree"
            | "start_topic_conversation"
            | "request_service_restart"
            | "create_automation"
            | "delete_automation"
            | "run_due_automations"
    ) || super::effect::is_managed_project_ledger_effect(&call.name)
    {
        return super::effect::execute(owner, invocation, call, call_id).await;
    }
    if crate::host::guided_project_tools::NativeGuidedProjectTools::supports(&call.name) {
        let workspace = owner
            .binding
            .workspace_reference
            .as_ref()
            .map(crate::workspace::WorkspaceReference::get)
            .transpose()
            .map_err(|error| {
                ToolExecutionError::Integrity(BtccError::new(
                    "project_workspace_unavailable",
                    error.code,
                ))
            })?
            .unwrap_or_else(|| owner.binding.workspace_path.clone());
        let result = owner.project.execute(&call.name, &call.arguments,
            crate::host::guided_project_tools::ProjectToolScope {
                project_id: owner.binding.memory.project_id.clone(),
                workspace_path: workspace,
                installation_root: owner.binding.installation_root.clone(),
            }).await.unwrap_or_else(|error| json!({"ok":false,"error":{
                "code":"tool_error", "message":format!("{} could not complete: {}", call.name, error.code)
            }}));
        return encoded(&result);
    }
    let args = Value::Object(call.arguments.clone());
    if matches!(
        call.name.as_str(),
        "read_tool_output_artifact" | "read_tool_evidence_artifact"
    ) {
        let result = if call.name == "read_tool_output_artifact" {
            owner.tool_artifacts.read_output(args).await
        } else {
            owner.tool_artifacts.read_evidence(args).await
        };
        return result.map_err(|error| {
            ToolExecutionError::Integrity(BtccError::new(error.code, error.message))
        });
    }
    let result = match call.name.as_str() {
        "list_conversation_sessions" => owner
            .conversation_tools
            .list(owner.binding.memory.clone(), args)
            .await
            .map_err(|error| BtccError::new(error.code, error.message)),
        "read_conversation_context" => owner
            .conversation_tools
            .read_context(owner.binding.memory.runtime_session_id.clone(), args)
            .await
            .map_err(|error| BtccError::new(error.code, error.message)),
        "recall_memory" => owner
            .recall
            .recall_tool(
                owner.binding.memory.clone(),
                owner.binding.current_user_message.clone(),
                call_id.to_owned(),
                args,
            )
            .await
            .map_err(|error| BtccError::new(error.code, error.message)),
        "query_memory" => owner
            .query
            .query(owner.binding.memory.clone(), args)
            .await
            .map_err(|error| BtccError::new(error.code, error.message)),
        "read_conversation_session" => owner
            .conversations
            .read(owner.binding.memory.clone(), args)
            .await
            .map_err(|error| BtccError::new(error.code, error.message)),
        "read_file" | "list_files" | "grep_files" | "list_skills" => owner
            .capabilities
            .invoke(
                &call.name,
                CapabilityInvocation {
                    call: &json!({"arguments": args, "projectId": owner.binding.memory.project_id}),
                    workspace_reference: owner.binding.workspace_reference.as_ref(),
                    workspace_path: Some(&owner.binding.workspace_path),
                    butler_data: &owner.binding.butler_data,
                    protected_ledger_roots: &owner.binding.protected_ledger_roots,
                    allowed_tools_and_effects: owner.binding.allowed_tools_and_effects.as_deref(),
                    mutation_scope: owner.binding.mutation_scope.as_deref(),
                    installation_root: owner.binding.installation_root.as_deref(),
                },
            )
            .await
            .map_err(|error| BtccError::new(error.code.clone(), error.code)),
        _ => {
            return Err(ToolExecutionError::Integrity(BtccError::new(
                "guided_tool_executor_missing",
                "Tool has no native executor",
            )));
        }
    };
    encoded(&result.unwrap_or_else(|error| {
        json!({"ok":false,"error":{
            "code":"tool_error", "message":format!("{} could not complete: {}",call.name,error.code)
        }})
    }))
}

fn encoded(value: &Value) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(value).map_err(|error| {
        ToolExecutionError::Integrity(BtccError::new("guided_tool_result_json", error.to_string()))
    })
}

pub(super) async fn execute_work(
    owner: &NativeGuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<Value, ToolExecutionError> {
    let prior = if NativeGuidedWorkTools::repairs_completed_relation(&call.name) {
        owner
            .journal
            .completed_call_identities(owner.binding.turn_id.clone())
            .await
            .map_err(|error| {
                ToolExecutionError::Integrity(BtccError::new(error.code, error.message))
            })?
            .into_iter()
            .filter(|(_, name)| !NativeGuidedWorkTools::is_work_tool(name))
            .map(|(id, _)| id)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    owner
        .work
        .execute(
            &owner.binding.turn_id,
            &call.name,
            &call.arguments,
            call_id,
            &prior,
            None,
        )
        .await
        .map_err(ToolExecutionError::Integrity)
}
