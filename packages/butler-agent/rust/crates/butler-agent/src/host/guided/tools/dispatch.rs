//! Invoke the concrete domain owner; the caller owns occurrence and result journaling.

mod mcp;
mod publication;
mod steward;
mod web;
mod work;
use butler_core::tool_protocol::ToolName;
pub(super) use publication::publish_work_result;

use serde_json::{Value, json};

use butler_core::json::JsonDocument;
use butler_runtime::capabilities::CapabilityInvocation;
use butler_turn::btcc::{BtccError, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};

use super::GuidedTools;
use crate::host::GuidedWorkTools;
pub(super) use work::execute_work;

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    if super::image::supports(&call.name) {
        return Box::pin(super::image::execute(owner, invocation, call)).await;
    }
    if super::memory_write::supports(&call.name) {
        return super::memory_write::execute(owner, invocation, call, call_id).await;
    }
    if web::supports(&call.name) {
        return web::execute(owner, invocation, call).await;
    }
    if matches!(
        ToolName::parse(call.name.as_str()),
        Some(ToolName::ToolSearch | ToolName::ToolDescribe | ToolName::ToolCall)
    ) {
        return Box::pin(super::discovery::execute(owner, invocation, call, call_id)).await;
    }
    if call.name == ToolName::CallMcpTool {
        return super::effect::execute(owner, invocation, call, call_id).await;
    }
    if super::profile::supports(&call.name) {
        return super::profile::execute(owner, call).await;
    }
    if super::monitoring::supports(&call.name) {
        return super::monitoring::execute(owner, call).await;
    }
    if call.name == ToolName::ReadProjectSource {
        return super::project_source::execute(owner, call).await;
    }
    if super::wallpaper::supports(&call.name) {
        return super::wallpaper::execute(owner, invocation, call, call_id).await;
    }
    if mcp::supports(&call.name) {
        return Box::pin(mcp::execute(owner, invocation, call)).await;
    }
    if call.name == ToolName::DelegateToSteward {
        return steward::execute(owner, invocation, call).await;
    }
    if call.name == ToolName::ListAutomations {
        return list_automations(owner, call).await;
    }
    if call.name == ToolName::DelegateToWorker {
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
                butler_turn::btcc::WorkerDelegationRequest {
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
                },
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
        return encoded(&result);
    }
    if matches!(
        ToolName::parse(call.name.as_str()),
        Some(ToolName::SteerSteward | ToolName::SteerWorker)
    ) {
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
        return encoded(&result);
    }
    if call.name == ToolName::CancelSteward {
        let result = owner
            .subsessions
            .cancel(butler_turn::btcc::SubsessionCancelRequest {
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
                child_role: butler_turn::workspace::SessionRole::Steward,
            })
            .await
            .map_err(ToolExecutionError::Integrity)?;
        return encoded(&result);
    }
    if call.name == ToolName::WaitForWorker {
        let waiting = owner
            .subsessions
            .should_wait_for_child(&owner.binding.source_session_id)
            .await
            .map_err(ToolExecutionError::Integrity)?;
        return encoded(&json!({"ok":true,"status":if waiting{"waiting"}else{"no_active_worker"}}));
    }
    if GuidedWorkTools::is_work_tool(&call.name) {
        return encoded(&execute_work(owner, call, call_id).await?);
    }
    if matches!(
        ToolName::parse(call.name.as_str()),
        Some(
            ToolName::UpdateTodoList
                | ToolName::ListTodoList
                | ToolName::ListWorkStreams
                | ToolName::UpdateWorkStreamState
        )
    ) {
        let result = owner
            .work_streams
            .execute(
                &call.name,
                crate::host::guided::work_streams::WorkStreamScope {
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
        ToolName::parse(call.name.as_str()),
        Some(
            ToolName::RunCommand
                | ToolName::WriteFile
                | ToolName::EditFile
                | ToolName::BindSessionGitWorktree
                | ToolName::StartTopicConversation
                | ToolName::RequestServiceRestart
                | ToolName::CreateAutomation
                | ToolName::UpdateAutomation
                | ToolName::DeleteAutomation
                | ToolName::RunDueAutomations
        )
    ) || super::effect::is_managed_project_ledger_effect(&call.name)
    {
        return super::effect::execute(owner, invocation, call, call_id).await;
    }
    if crate::host::guided::project_tools::GuidedProjectTools::supports(&call.name) {
        let workspace = owner
            .binding
            .workspace_reference
            .as_ref()
            .map(butler_turn::workspace::WorkspaceReference::get)
            .transpose()
            .map_err(|error| {
                ToolExecutionError::Integrity(BtccError::relayed(
                    "project_workspace_unavailable",
                    error.code(),
                ))
            })?
            .unwrap_or_else(|| owner.binding.workspace_path.clone());
        let result = owner.project.execute(&call.name, &call.arguments,
            crate::host::guided::project_tools::ProjectToolScope {
                project_id: owner.binding.memory.project_id.clone(),
                workspace_path: workspace,
                installation_root: owner.binding.installation_root.clone(),
            }).await.unwrap_or_else(|error| json!({"ok":false,"error":{
                "code":"tool_error", "message":format!("{} could not complete: {}", call.name, error.code())
            }}));
        return encoded(&result);
    }
    let args = Value::Object(call.arguments.clone());
    if matches!(
        ToolName::parse(call.name.as_str()),
        Some(ToolName::ReadToolOutputArtifact | ToolName::ReadToolEvidenceArtifact)
    ) {
        let result = if call.name == ToolName::ReadToolOutputArtifact {
            owner.tool_artifacts.read_output(args).await
        } else {
            owner.tool_artifacts.read_evidence(args).await
        };
        return result.map_err(|error| {
            ToolExecutionError::Integrity(BtccError::relayed(error.code(), error.message()))
        });
    }
    let result = match call.name.as_str() {
        "list_conversation_sessions" => owner
            .conversation_tools
            .list(owner.binding.memory.clone(), args)
            .await
            .map_err(|error| BtccError::relayed(error.code(), error.message())),
        "read_conversation_context" => owner
            .conversation_tools
            .read_context(owner.binding.memory.runtime_session_id.clone(), args)
            .await
            .map_err(|error| BtccError::relayed(error.code(), error.message())),
        "recall_memory" => owner
            .recall
            .recall_tool(
                owner.binding.memory.clone(),
                owner.binding.current_user_message.clone(),
                call_id.to_owned(),
                args,
            )
            .await
            .map_err(|error| BtccError::relayed(error.code(), error.message())),
        "query_memory" => owner
            .query
            .query(owner.binding.memory.clone(), args)
            .await
            .map_err(|error| BtccError::relayed(error.code(), error.message())),
        "read_conversation_session" => owner
            .conversations
            .read(owner.binding.memory.clone(), args)
            .await
            .map_err(|error| BtccError::relayed(error.code(), error.message())),
        "read_file" | "list_files" | "grep_files" | "list_skills" | "load_skill"
        | "read_skill_file" => file_capability(owner, call, &args).await,
        _ => {
            return Err(ToolExecutionError::Integrity(BtccError::relayed(
                "guided_tool_executor_missing",
                "Tool has no native executor",
            )));
        }
    };
    encoded(&result.unwrap_or_else(|error| super::message::tool_failure(&call.name, error.code())))
}

async fn file_capability(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    args: &Value,
) -> Result<Value, BtccError> {
    owner
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
        .map_err(|error| BtccError::relay(error.code(), error.code(), error))
}

/// The Turn's access mode as delegation requests name it.
fn access_mode(owner: &GuidedTools) -> String {
    match owner.binding.access_mode {
        butler_turn::btcc::AccessMode::FullAccess => "full_access",
        butler_turn::btcc::AccessMode::AskFirst => "ask_first",
        butler_turn::btcc::AccessMode::ReadOnly => "read_only",
    }
    .into()
}

async fn list_automations(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let result = match crate::host::automation::client::ScheduleClient::active(&owner.app_endpoint)
    {
        Ok(client) => {
            client
                .tool(
                    &call.name,
                    call.arguments.clone(),
                    &owner.binding.source_session_id,
                )
                .await
        }
        Err(error) => Err(error),
    };
    encoded(&result.unwrap_or_else(|error| {
        json!({"ok":false,"error":{
            "code":error.code(), "message":error.message(),
        }})
    }))
}

fn encoded(value: &Value) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(value).map_err(|error| {
        ToolExecutionError::Integrity(BtccError::relayed(
            "guided_tool_result_json",
            error.to_string(),
        ))
    })
}
