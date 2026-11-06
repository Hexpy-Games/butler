//! Approval-free entry into the same browser executor.
use super::*;

/// Whether a nested browse step of this tool would be dispatched for this caller.
pub(in crate::host::guided::tools) fn executor_admits(owner: &GuidedTools, name: &str) -> bool {
    admitted(owner, name) && owner.authorized(name)
}

pub(in crate::host::guided::tools) async fn execute_executor(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    if !executor_admits(owner, &call.name) {
        return encoded(&json!({"status":"not_dispatched","reason":"tool_not_admitted"}));
    }
    let Some(mut client) = client::Client::new(owner).await else {
        return encoded(&json!({"status":"unavailable","reason":"no_browser"}));
    };
    client.approval_handoff = true;
    execute_client(
        owner,
        invocation,
        call,
        occurrence,
        client,
        Value::Object(call.arguments.clone()),
    )
    .await
}

pub(in crate::host::guided::tools) fn handoff(args: &Value, reason: &str) -> Value {
    json!({"status":"needs_approval","reason":reason,
        "handoff":{"tab":args["tab"],"observation":args["observation"],"steps":args["steps"]}})
}
