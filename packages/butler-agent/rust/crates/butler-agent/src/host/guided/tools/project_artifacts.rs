//! Explicit project artifact discovery. No prompt snapshot or background work.
mod query;
mod read;

use super::GuidedTools;
use butler_core::json::JsonDocument;
use butler_turn::btcc::{BtccError, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let Some(project) = owner.binding.project_id.clone() else {
        return encoded(&json!({"ok":false,"error":"no_project",
            "message":"This chat has no project."}));
    };
    let Ok(request) = serde_json::from_value::<query::Request>(json!(call.arguments)) else {
        return encoded(&json!({"ok":false,"error":"invalid_arguments"}));
    };
    let result = if request.read_handle.is_some() {
        read::execute(owner, invocation, &project, request).await
    } else {
        let root = owner.binding.butler_data.clone();
        let signal = invocation.cancellation.clone();
        tokio::select! {
            biased;
            () = invocation.cancellation.cancelled() => Err("cancelled".into()),
            result = tokio::task::spawn_blocking(move || {
                query::page(&root, &project, &request, signal)
            }) => result.unwrap_or_else(|_| Err("artifact_index_unavailable".into())),
        }
    };
    encoded(&result.unwrap_or_else(|error| failure(&error)))
}

fn encoded(value: &Value) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(value).map_err(|error| {
        ToolExecutionError::Integrity(BtccError::relayed(
            "project_artifacts_result",
            error.to_string(),
        ))
    })
}

fn failure(code: &str) -> Value {
    let mut value = json!({"ok":false,"error":code});
    if matches!(code, "source_changed" | "source_snapshot_changed") {
        value["recovery_hint"] = json!(
            "Run project_artifacts without a cursor or read_handle to find the current delivered revision."
        );
    } else if code == "source_unavailable" {
        value["message"] = json!("Content is missing or no longer available in this project.");
    }
    value
}
