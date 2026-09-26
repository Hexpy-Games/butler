use serde_json::{Value, json};

use super::NativeGuidedTools;
use crate::btcc::{GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use crate::json::JsonDocument;

pub(super) fn supports(name: &str) -> bool {
    matches!(name, "web_search" | "web_read")
}

pub(super) async fn execute(
    owner: &NativeGuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let arguments = Value::Object(call.arguments.clone());
    let result = if call.name == "web_search" {
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
        |error| json!({"ok":false,"error":{"code":error.code,"message":error.message}}),
    );
    super::encoded(&result)
}
