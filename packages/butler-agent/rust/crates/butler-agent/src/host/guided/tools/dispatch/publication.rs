use crate::btcc::{GuidedInvocation, ToolExecutionError};
use crate::host::GuidedWorkTools;

use super::GuidedTools;

/// The stable occurrence is still in scope here; provider IDs are not unique keys.
pub(in crate::host::guided::tools) async fn publish_work_result(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    name: &str,
    call_id: &str,
    result: &butler_core::json::JsonDocument,
) -> Result<(), ToolExecutionError> {
    if GuidedWorkTools::is_work_tool(name) && result.field("ok").ok().flatten() == Some("true") {
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
