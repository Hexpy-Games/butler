//! Explicit project artifact discovery. No prompt snapshot or background work.
mod query;

use butler_core::json::JsonDocument;
use butler_turn::btcc::{BtccError, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};
use super::GuidedTools;

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let Some(project) = owner.binding.project_id.clone() else {
        return encoded(json!({"ok":false,"error":"no_project",
            "message":"This chat has no project."}));
    };
    let request = match serde_json::from_value::<query::Request>(json!(call.arguments)) {
        Ok(request) => request,
        Err(_) => return encoded(json!({"ok":false,"error":"invalid_arguments"})),
    };
    let root = owner.binding.butler_data.clone();
    let result = tokio::select! {
        biased;
        () = invocation.cancellation.cancelled() => {
            return encoded(json!({"ok":false,"error":"cancelled"}));
        }
        result = tokio::task::spawn_blocking(move || query::page(&root, &project, &request)) => {
            result.unwrap_or_else(|_| Err("artifact_index_unavailable".into()))
        }
    };
    encoded(result.unwrap_or_else(|error| json!({"ok":false,"error":error})))
}

fn encoded(value: Value) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(&value).map_err(|error| {
        ToolExecutionError::Integrity(BtccError::relayed("project_artifacts_result", error.to_string()))
    })
}
