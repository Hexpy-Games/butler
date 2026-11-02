//! Preserve command scope violations in the normal tool journal and child result.
use super::*;
use butler_core::json::JsonDocument;
use butler_turn::btcc::{GuidedInvocation, ModelRoundToolCall, ToolExecutionError};

pub(super) async fn dispatch(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
    name: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let worker = invocation
        .turn
        .context
        .pointer("/executionPolicy/role")
        .and_then(Value::as_str)
        == Some("worker");
    let scopes = owner
        .binding
        .mutation_scope
        .as_deref()
        .filter(|_| name == "run_command" && worker);
    let before = if scopes.is_some() {
        Some(
            owner
                .command
                .task_write_snapshot(&owner.binding.workspace_path, &owner.binding.butler_data)
                .await
                .map_err(ToolExecutionError::Integrity)?,
        )
    } else {
        None
    };
    let result = super::execute::dispatch_result(owner, invocation, call, call_id).await?;
    let (Some(before), Some(scopes)) = (before, scopes) else {
        return Ok(result);
    };
    let errors = owner
        .command
        .task_write_errors(
            before,
            &owner.binding.workspace_path,
            &owner.binding.butler_data,
            scopes,
        )
        .await
        .map_err(ToolExecutionError::Integrity)?;
    if errors.is_empty() {
        return Ok(result);
    }
    annotate(&result, &errors).map_err(|e| {
        ToolExecutionError::Integrity(BtccError::relayed(
            "task_scope_result_invalid",
            e.to_string(),
        ))
    })
}

fn annotate(
    result: &JsonDocument,
    errors: &[String],
) -> Result<JsonDocument, butler_core::json::JsonError> {
    let mut encoded = String::from("{\"ok\":false,\"task_scope_errors\":");
    encoded.push_str(&serde_json::to_string(errors)?);
    butler_core::json::visit_raw_object(result.as_str(), |key, value| {
        let name: String = serde_json::from_str(key)?;
        if name != "ok" && name != "task_scope_errors" {
            encoded.push(',');
            encoded.push_str(key);
            encoded.push(':');
            encoded.push_str(value);
        }
        Ok(())
    })?;
    encoded.push('}');
    JsonDocument::from_encoded(encoded)
}
