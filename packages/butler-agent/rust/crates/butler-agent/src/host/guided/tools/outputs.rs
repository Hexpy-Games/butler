//! Session-bound output publication. P1a deliberately has no browser executor.
use super::GuidedTools;
use butler_runtime::outputs::{OutputStore, PublishRequest};
use butler_turn::btcc::{AccessMode, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};

pub(super) async fn publish(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<butler_core::json::JsonDocument, ToolExecutionError> {
    if owner.binding.access_mode == AccessMode::ReadOnly {
        return super::dispatch::encoded(&json!({"ok":false,"error":"tool_not_admitted"}));
    }
    let args = &call.arguments;
    let request = PublishRequest {
        workspace: owner.binding.workspace_path.clone(),
        path: args
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        entry: args.get("entry").and_then(Value::as_str).map(str::to_owned),
        title: args
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        session_id: owner
            .binding
            .app_session_id
            .clone()
            .unwrap_or_else(|| owner.binding.source_session_id.clone()),
        message_id: invocation.turn.original_message_id.clone(),
        turn_id: owner.binding.turn_id.clone(),
    };
    if owner
        .binding
        .allowed_tools_and_effects
        .as_ref()
        .is_some_and(|names| {
            !names.iter().any(|n| {
                n == "output_publish"
                    || n == "output_publish:workspace"
                    || n == "write_file:workspace"
            })
        })
    {
        return super::dispatch::encoded(&json!({"ok":false,"error":"tool_not_admitted"}));
    }
    let store = OutputStore::new(&owner.binding.butler_data);
    let result = tokio::task::spawn_blocking(move || store.publish(request)).await;
    let value = match result {
        Ok(Ok((output, new_blobs))) => {
            let revision = output.revisions.last().map_or(0, |r| r.revision);
            json!({"output_id":output.output_id,"revision":revision,"view":format!("/outputs/{}/view",output.output_id),"new_blobs":new_blobs,"check":{"status":"unavailable","reason":"not_implemented"}})
        }
        Ok(Err(error)) => json!({"ok":false,"error":error.to_string()}),
        Err(_) => json!({"ok":false,"error":"output_publish_failed"}),
    };
    super::dispatch::encoded(&value)
}
