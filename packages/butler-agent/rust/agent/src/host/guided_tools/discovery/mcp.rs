use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::btcc::{BtccError, ToolExecutionError};
use crate::json::JsonDocument;

use super::{NativeGuidedTools, bridge_error, encoded};

pub(super) async fn search(
    owner: &NativeGuidedTools,
    args: &Map<String, Value>,
    category: Option<&str>,
    signal: &CancellationToken,
) -> Result<JsonDocument, ToolExecutionError> {
    let can_discover = owner.binding.authorized_names.contains("call_mcp_tool")
        || owner
            .binding
            .authorized_names
            .contains("list_mcp_capabilities");
    if !can_discover {
        return encoded(&json!({"ok":true,"results":[]}));
    }
    let call_available = owner.binding.authorized_names.contains("call_mcp_tool");
    let mut filtered = args.clone();
    if let Some(category) = category {
        filtered.insert("category".into(), Value::String(category.into()));
    } else {
        filtered.remove("category");
    }
    match crate::mcp_client::search_mcp_tool_catalog(
        &owner.mcp_client,
        &filtered,
        call_available,
        signal,
    )
    .await
    {
        Ok(result) => encoded(&result),
        Err(error) => encoded(&bridge_error(
            error.code,
            "The MCP server catalog could not be loaded. Retry discovery or choose an enabled native tool.",
        )),
    }
}

pub(super) async fn describe(
    owner: &NativeGuidedTools,
    id: &str,
    signal: &CancellationToken,
) -> Result<Option<Value>, ToolExecutionError> {
    let Some(parsed) = crate::mcp_client::parse_mcp_catalog_id(id) else {
        return Ok(None);
    };
    let call_available = owner.binding.authorized_names.contains("call_mcp_tool");
    crate::mcp_client::describe_mcp_tool(
        &owner.mcp_client,
        id,
        &parsed.server_id,
        &parsed.tool_name,
        call_available,
        signal,
    )
    .await
    .map_err(|error| ToolExecutionError::Integrity(BtccError::new(error.code, error.message)))
}
