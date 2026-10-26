//! Durable Work tool calls, including repair of completed relations.

use serde_json::Value;

use crate::host::GuidedWorkTools;
use crate::host::guided::tools::GuidedTools;
use butler_turn::btcc::{ModelRoundToolCall, ToolExecutionError};

pub(in crate::host::guided::tools) async fn execute_work(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<Value, ToolExecutionError> {
    if let Some(result) = settled_disposition(owner, call).await? {
        return Ok(result);
    }
    let prior = if GuidedWorkTools::repairs_completed_relation(&call.name) {
        owner
            .journal
            .completed_call_identities(owner.binding.turn_id.clone())
            .await
            .map_err(|error| ToolExecutionError::Integrity(error.into()))?
            .into_iter()
            .filter(|(_, name)| !GuidedWorkTools::is_work_tool(name))
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

async fn settled_disposition(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
) -> Result<Option<Value>, ToolExecutionError> {
    if call.name != butler_core::tool_protocol::ToolName::RecordWorkDisposition {
        return Ok(None);
    }
    let Some(work_id) = call.arguments.get("work_id").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(work) = owner
        .subsessions
        .delegated_parent_work(owner.binding.source_session_id.clone(), work_id.into())
        .await
        .map_err(ToolExecutionError::Integrity)?
    else {
        return Ok(None);
    };
    GuidedWorkTools::settled_disposition(&work).map_err(ToolExecutionError::Integrity)
}
