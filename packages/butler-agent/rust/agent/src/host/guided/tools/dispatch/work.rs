//! Durable Work tool calls, including repair of completed relations.

use serde_json::Value;

use crate::btcc::{ModelRoundToolCall, ToolExecutionError};
use crate::host::NativeGuidedWorkTools;
use crate::host::guided::tools::NativeGuidedTools;

pub(in crate::host::guided::tools) async fn execute_work(
    owner: &NativeGuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<Value, ToolExecutionError> {
    let prior = if NativeGuidedWorkTools::repairs_completed_relation(&call.name) {
        owner
            .journal
            .completed_call_identities(owner.binding.turn_id.clone())
            .await
            .map_err(|error| ToolExecutionError::Integrity(error.into()))?
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
