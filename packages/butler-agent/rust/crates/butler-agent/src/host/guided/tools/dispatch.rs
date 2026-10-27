//! Invoke the concrete domain owner; the caller owns occurrence and result journaling.

pub(super) mod file_observation;
mod link_targets;
mod mcp;
mod project;
mod publication;
mod steward;
pub(super) mod web;
pub(super) use web::web_provenance;
pub(super) mod steward_gate;
mod work;
mod worker;
use butler_core::tool_protocol::ToolName;
pub(super) use publication::publish_work_result;

use serde_json::{Value, json};

use butler_core::json::JsonDocument;
use butler_runtime::capabilities::CapabilityInvocation;
use butler_turn::btcc::{BtccError, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};

use super::GuidedTools;
use crate::host::GuidedWorkTools;
pub(super) use work::execute_work;

/// Runs `call` with its paths naming the places the OS reaches (see
/// `link_targets`), so access, approval and execution agree on the target.
pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let resolved = link_targets::resolve(owner, call)
        .await
        .map_err(ToolExecutionError::Integrity)?;
    let call = resolved.as_ref().unwrap_or(call);
    if super::browser::supports(&call.name) {
        return super::browser::execute(owner, &invocation, call, call_id).await;
    }
    if super::effect::routes_effect(&call.name) {
        return super::effect::execute(owner, invocation, call, call_id).await;
    }
    if super::direct_approval::supports(call) {
        return Box::pin(super::direct_approval::execute(
            owner, invocation, call, call_id,
        ))
        .await;
    }
    if web::supports(&call.name) {
        return web::execute(owner, invocation, call, call_id).await;
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
    if call.name == ToolName::DelegateToSteward || call.name == ToolName::ReadPriorDelegation {
        return Box::pin(steward::execute(owner, invocation, call, call_id)).await;
    }
    if call.name == ToolName::ListAutomations {
        return list_automations(owner, call).await;
    }
    if call.name == ToolName::DelegateToWorker {
        return worker::execute(owner, invocation, call, call_id).await;
    }
    if matches!(
        ToolName::parse(call.name.as_str()),
        Some(ToolName::SteerSteward | ToolName::SteerWorker)
    ) {
        return steward::steer(owner, invocation, call).await;
    }
    if call.name == ToolName::CancelSteward {
        return steward::cancel(owner, invocation, call).await;
    }
    if let Some(result) = state_tool(owner, call, call_id).await {
        return result;
    }
    effect_or_read(owner, invocation, call, call_id).await
}

async fn state_tool(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Option<Result<JsonDocument, ToolExecutionError>> {
    if call.name == ToolName::WaitForWorker {
        let waiting = match owner
            .subsessions
            .should_wait_for_child(&owner.binding.source_session_id)
            .await
        {
            Ok(waiting) => waiting,
            Err(error) => return Some(Err(ToolExecutionError::Integrity(error))),
        };
        return Some(encoded(
            &json!({"ok":true,"status":if waiting{"waiting"}else{"no_active_worker"}}),
        ));
    }
    if GuidedWorkTools::is_work_tool(&call.name) {
        return Some(match execute_work(owner, call, call_id).await {
            Ok(value) => encoded(&value),
            Err(error) => Err(error),
        });
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
            .map_err(ToolExecutionError::Integrity);
        return Some(result.and_then(|value| encoded(&value)));
    }
    None
}

async fn effect_or_read(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
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
    ) {
        return super::effect::execute(owner, invocation, call, call_id).await;
    }
    if crate::host::guided::project_tools::GuidedProjectTools::supports(&call.name) {
        return project::execute(owner, call).await;
    }
    if let Some(result) = domain_tool(owner, &invocation, call, call_id).await {
        return result;
    }
    let args = Value::Object(call.arguments.clone());
    if matches!(
        ToolName::parse(call.name.as_str()),
        Some(ToolName::ReadToolOutputArtifact | ToolName::ReadToolEvidenceArtifact)
    ) {
        return read_tool_artifact(owner, &call.name, args).await;
    }
    read_native(owner, call, call_id, args).await
}

async fn read_native(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
    args: Value,
) -> Result<JsonDocument, ToolExecutionError> {
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
        "list_skills" | "load_skill" | "read_skill_file" => {
            file_capability(owner, call, &args, false).await
        }
        _ => {
            return Err(ToolExecutionError::Integrity(BtccError::relayed(
                "guided_tool_executor_missing",
                "Tool has no native executor",
            )));
        }
    };
    encoded(&result.unwrap_or_else(|error| super::message::tool_failure(&call.name, error.code())))
}

async fn read_tool_artifact(
    owner: &GuidedTools,
    name: &str,
    args: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    let result = if name == ToolName::ReadToolOutputArtifact {
        owner.tool_artifacts.read_output(args).await
    } else {
        owner.tool_artifacts.read_evidence(args).await
    };
    result.map_err(|error| {
        ToolExecutionError::Integrity(BtccError::relayed(error.code(), error.message()))
    })
}

async fn file_capability(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    args: &Value,
    contained: bool,
) -> Result<Value, BtccError> {
    owner
        .capabilities
        .invoke(
            &call.name,
            CapabilityInvocation {
                contained,
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
    owner.binding.access_mode.as_str().into()
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

pub(super) fn encoded(value: &Value) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(value).map_err(|error| {
        ToolExecutionError::Integrity(BtccError::relayed(
            "guided_tool_result_json",
            error.to_string(),
        ))
    })
}

pub(super) async fn domain_tool(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Option<Result<JsonDocument, ToolExecutionError>> {
    if matches!(
        call.name.as_str(),
        "connector_fetch"
            | "connector_rule_list"
            | "connector_rule_remove"
            | "connector_rule_set"
            | "connector_triage"
    ) {
        let result = owner
            .mcp_client
            .connector_tool(
                call.name.clone(),
                Value::Object(call.arguments.clone()),
                owner.binding.access_mode == butler_turn::btcc::AccessMode::ReadOnly,
            )
            .await;
        return Some(encoded(
            &result.unwrap_or_else(|e| json!({"ok":false,"error":{"code":e.code}})),
        ));
    }
    if super::documents::supports(&call.name) {
        return Some(super::documents::execute(owner, call, invocation).await);
    }
    if super::library::supports(&call.name) {
        return Some(super::library::execute(owner, call).await);
    }
    match call.name.as_str() {
        "generate_image" | "edit_image" => {
            Some(super::image_gen::execute(owner, *invocation, call, call_id).await)
        }
        "answer_blocks" => {
            Some(super::answer_blocks::execute(owner, call, call_id, invocation.progress).await)
        }
        "output_check" => Some(super::outputs::inspect(owner, invocation, call).await),
        "deliver_files" => Some(super::deliver::execute(owner, call).await),
        "output_publish" => Some(super::outputs::publish(owner, invocation, call).await),
        "read_file" | "list_files" | "grep_files" => {
            Some(file_observation::execute(owner, call, call_id).await)
        }
        _ => None,
    }
}
