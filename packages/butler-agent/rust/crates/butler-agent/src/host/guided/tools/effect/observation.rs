//! Observation admission: preserve isolation where available, otherwise
//! ask-first approves the exact observation without requiring a Plan effect.
use super::super::dispatch::file_observation::{Gate, gate};
use super::{GuidedTools, ordinary};
use crate::host::guided::command::CommandScope;
use butler_core::{json::JsonDocument, tool_protocol::ToolName};
use butler_turn::btcc::{
    AccessDecision, AuthorityOutcomeInput, ModelRoundToolCall, ToolExecutionError,
};
use serde_json::Value;

pub(super) async fn execute(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
    scope: &CommandScope<'_>,
) -> Result<Option<JsonDocument>, ToolExecutionError> {
    if call.name != ToolName::RunCommand
        || matches!(
            call.arguments.get("state_effect").and_then(Value::as_str),
            Some("mutation" | "remote_observation")
        )
    {
        return Ok(None);
    }
    let mut input = Value::Object(call.arguments.clone());
    if input.get("state_effect").is_none() {
        input["state_effect"] = "read_only".into();
    }
    let decision = super::super::access::decision(owner, call, &input)
        .await
        .map_err(ToolExecutionError::Integrity)?;
    let needs_approval = matches!(decision, AccessDecision::Ask(_))
        || super::super::access::resumes(owner, occurrence);
    let approval = if needs_approval {
        match gate(owner, call, occurrence, &input).await? {
            Gate::Pending(value) => {
                return JsonDocument::from_value(&value)
                    .map(Some)
                    .map_err(super::wire_error);
            }
            Gate::Allowed(reference) => reference,
        }
    } else {
        None
    };
    let mut approved_scope = scope.clone();
    if needs_approval && !butler_platform::command_sandbox::READ_ONLY_SANDBOX {
        approved_scope.execution = crate::host::guided::command::CommandExecution::Registered;
    }
    if !needs_approval && owner.binding.access_mode.reviews_effects() {
        if butler_platform::command_sandbox::READ_ONLY_SANDBOX {
            approved_scope.contained_reads = true;
        } else {
            approved_scope.execution = crate::host::guided::command::CommandExecution::Registered;
        }
    }
    let result = owner
        .command
        .execute_observation(&call.arguments, approved_scope)
        .await
        .map(Some);
    if let Some(request_ref) = approval {
        owner
            .authority
            .record_outcome(AuthorityOutcomeInput {
                request_ref,
                owner_session_id: owner.binding.owner_session_id.clone(),
                source_work_id: String::new(),
                status: if result.is_ok() { "applied" } else { "failed" }.into(),
                receipt: None,
            })
            .await
            .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
        *owner.authority_consumed.lock() = true;
    }
    match result {
        Ok(result) => Ok(result),
        Err(error) => ordinary(error.code(), error.message(), None).map(Some),
    }
}
