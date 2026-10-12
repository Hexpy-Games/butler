use serde_json::{Value, json};

use super::GuidedTools;
use butler_core::json::JsonDocument;
use butler_core::tool_protocol::ToolName;
use butler_turn::btcc::{GuidedInvocation, ModelRoundToolCall, ToolExecutionError};

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
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let arguments = Value::Object(call.arguments.clone());
    let result = if call.name == ToolName::WebSearch {
        owner
            .web_session
            .web_search(&arguments, invocation.cancellation)
            .await
    } else {
        // A page already open in a tab is read there, not fetched again.
        let live = match super::super::browser::live_page(owner, &invocation, &arguments).await {
            Ok(live) => live,
            Err(refused) => return super::encoded(&refused),
        };
        owner
            .web_session
            .web_read_from(&arguments, live, invocation.cancellation)
            .await
    }
    .unwrap_or_else(
        |error| json!({"ok":false,"error":{"code":error.code(),"message":error.message()}}),
    );
    if call.name == ToolName::WebRead
        && result["ok"] == true
        && let Some(source) = result["source_url"].as_str()
    {
        super::super::answer_blocks::remember_source(owner, call_id, source).await?;
    }
    super::encoded(&result)
}
