use crate::btcc::{GuidedInvocation, ToolExecutionError};
use crate::host::NativeGuidedWorkTools;

use super::NativeGuidedTools;

/// The stable occurrence is still in scope here; provider IDs are not unique keys.
pub(in crate::host::guided_tools) async fn publish_work_result(
    owner: &NativeGuidedTools,
    invocation: GuidedInvocation<'_>,
    name: &str,
    call_id: &str,
    result: &crate::json::JsonDocument,
) -> Result<(), ToolExecutionError> {
    if NativeGuidedWorkTools::is_work_tool(name)
        && result.field("ok").ok().flatten() == Some("true")
    {
        let work = owner
            .work
            .accepted_work(name)
            .await
            .map_err(ToolExecutionError::Integrity)?;
        owner
            .activity
            .publish_accepted(
                &owner.binding.turn_id,
                call_id,
                work.as_ref(),
                invocation.progress,
            )
            .await
            .map_err(ToolExecutionError::Integrity)?;
    }
    Ok(())
}
