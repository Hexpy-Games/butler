//! Approval-free entry into the same browser executor.
use super::*;
pub(in crate::host::guided::tools) async fn execute_executor(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    if !admitted(owner, &call.name) || !owner.binding.authorized_names.contains(&call.name) {
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
