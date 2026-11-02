//! Nested page calls keep normal tool provenance and durable browser effect identities.
use super::*;
use butler_turn::btcc::ToolJournalFinishStatus;

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<Value, ToolExecutionError> {
    let args = Value::Object(call.arguments.clone());
    super::super::execute::start(owner, call, occurrence, &call.name, &args).await?;
    let result = if call.name == "web_read" {
        super::super::dispatch::web::execute_executor(owner, *invocation, call, occurrence).await
    } else {
        browser::execute_executor(owner, invocation, call, occurrence).await
    };
    let status = if result.is_ok() {
        ToolJournalFinishStatus::Completed
    } else {
        ToolJournalFinishStatus::Cancelled
    };
    super::super::execute::finish(owner, occurrence, status, result.as_ref().ok()).await?;
    let output = result?;
    owner.observe_result(&call.name, &args);
    browser::discover_reached(owner, &call.name, &output);
    let projected = if call.name == "web_read" {
        super::super::message::structured_raw(&call.name, output.as_str())
            .map_err(ToolExecutionError::Integrity)?
    } else {
        output.as_str().to_owned()
    };
    serde_json::from_str(&projected).map_err(|error| {
        ToolExecutionError::Integrity(
            butler_turn::btcc::BtccError::relayed("browse_tool_result_invalid", error.to_string())
                .with_source(error),
        )
    })
}
