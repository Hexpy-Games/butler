//! Observation admission: preserve isolation where available, otherwise
//! ask-first follows the ordinary exact-command authority/effect path.
use super::{GuidedTools, ordinary};
use crate::host::guided::command::CommandScope;
use butler_core::{json::JsonDocument, tool_protocol::ToolName};
use butler_turn::btcc::{AccessMode, ModelRoundToolCall, ToolExecutionError};
use serde_json::Value;

pub(super) async fn execute(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    scope: &CommandScope<'_>,
) -> Result<Option<JsonDocument>, ToolExecutionError> {
    if call.name != ToolName::RunCommand
        || matches!(
            call.arguments.get("state_effect").and_then(Value::as_str),
            Some("mutation" | "remote_observation")
        )
    {
        return Ok(None);
    }
    let needs_approval = owner.binding.access_mode == AccessMode::AskFirst
        && !butler_platform::command_sandbox::READ_ONLY_SANDBOX;
    let result = if needs_approval {
        owner.command.check_paths(&call.arguments, scope).await
    } else {
        owner
            .command
            .execute_observation(&call.arguments, scope.clone())
            .await
            .map(Some)
    };
    match result {
        Ok(result) => Ok(result),
        Err(error) => ordinary(error.code(), error.message(), None).map(Some),
    }
}
