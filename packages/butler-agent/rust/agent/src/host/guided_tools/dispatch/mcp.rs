use serde_json::{Value, json};

use crate::btcc::{GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use crate::json::JsonDocument;

use super::super::NativeGuidedTools;

pub(super) fn supports(name: &str) -> bool {
    matches!(name, "list_mcp_capabilities" | "read_mcp_resource")
}

pub(super) async fn execute(
    owner: &NativeGuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let value = match call.name.as_str() {
        "list_mcp_capabilities" => {
            let include_disabled =
                call.arguments.get("include_disabled") == Some(&Value::Bool(true));
            match Box::pin(
                owner
                    .mcp_client
                    .list_capabilities(include_disabled, invocation.cancellation),
            )
            .await
            {
                Ok(result) => json!({
                    "ok":true,
                    "servers":result.get("servers").cloned().unwrap_or_else(|| json!([])),
                }),
                Err(error) => json!({
                    "ok":false,
                    "error":{"code":error.code,"message":error.message},
                }),
            }
        }
        "read_mcp_resource" => {
            let server_id = call
                .arguments
                .get("server_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            let uri = call
                .arguments
                .get("uri")
                .and_then(Value::as_str)
                .unwrap_or("");
            match Box::pin(
                owner
                    .mcp_client
                    .read_resource(server_id, uri, invocation.cancellation),
            )
            .await
            {
                Ok(mut result) => {
                    result["ok"] = Value::Bool(true);
                    result
                }
                Err(error) => json!({
                    "ok":false,
                    "error":{"code":error.code,"message":error.message},
                }),
            }
        }
        _ => json!({"ok":false,"error":{"code":"mcp_tool_unknown","message":"Unknown MCP tool."}}),
    };
    super::encoded(&value)
}
