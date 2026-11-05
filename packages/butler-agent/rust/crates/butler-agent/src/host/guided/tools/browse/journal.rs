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
    // Nested steps pass the checks a direct call of the same tool passes.
    if let Err(ToolExecutionError::Integrity(error)) =
        super::super::dispatch::steward_gate::check(owner, call).await
    {
        return Ok(blocked(error.code(), error.message()));
    }
    if let Some(hooks) = &owner.binding.hooks
        && let Some(reason) = butler_turn::btcc::nested_pre_tool(hooks, *invocation, call).await
    {
        return Ok(blocked("hook_denied", &reason));
    }
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
    let value: Value = serde_json::from_str(&projected).map_err(|error| {
        ToolExecutionError::Integrity(
            butler_turn::btcc::BtccError::relayed("browse_tool_result_invalid", error.to_string())
                .with_source(error),
        )
    })?;
    if let Some(hooks) = &owner.binding.hooks {
        let ok = value["status"] == "ok" || value["ok"] == true;
        butler_turn::btcc::nested_post_tool(hooks, *invocation, call, ok, Some(output)).await;
    }
    Ok(value)
}

fn blocked(code: &str, message: &str) -> Value {
    json!({"status":"blocked","code":code,"message":message})
}
