use serde_json::{Value, json};

use super::GuidedTools;
use crate::btcc::{GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use butler_core::json::JsonDocument;
use butler_core::tool_protocol::ToolName;

pub(super) fn supports(name: &str) -> bool {
    matches!(
        ToolName::parse(name),
        Some(ToolName::WebSearch | ToolName::WebRead)
    )
}

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let arguments = Value::Object(call.arguments.clone());
    let result = if call.name == ToolName::WebSearch {
        owner
            .web_session
            .web_search(&arguments, invocation.cancellation)
            .await
    } else {
        owner
            .web_session
            .web_read(&arguments, invocation.cancellation)
            .await
    }
    .unwrap_or_else(
        |error| json!({"ok":false,"error":{"code":error.code(),"message":error.message()}}),
    );
    super::encoded(&result)
}
