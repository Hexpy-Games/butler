use super::{GuidedTools, encoded};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{BtccError, ModelRoundToolCall, ToolExecutionError};
use serde_json::json;

pub(super) async fn execute(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
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
    encoded(&result)
}
