//! Closeout requires an actual parent operation after a child's capability hand-back.
use butler_turn::btcc::{BtccError, CapabilityHandoff, ToolJournalRepository};
use serde_json::Value;
use std::sync::Arc;

pub(super) struct CapabilityRecovery {
    handoff: CapabilityHandoff,
    journal: Arc<ToolJournalRepository>,
}

impl CapabilityRecovery {
    pub(super) fn new(
        input: &str,
        granted: &[String],
        journal: Arc<ToolJournalRepository>,
    ) -> Option<Self> {
        let handoff = CapabilityHandoff::from_parent_input(input)?;
        granted
            .iter()
            .any(|name| name == &handoff.requested_action.tool_name)
            .then_some(Self { handoff, journal })
    }

    pub(super) async fn pending(&self, turn: &str) -> Result<bool, BtccError> {
        // Identity-only query scoped to this Turn; hydrate only the matching result.
        for call in self.journal.list_signatures(turn.into()).await? {
            let action = &self.handoff.requested_action;
            let args = if call.tool_name == action.tool_name {
                &call.arguments
            } else if call.tool_name == "tool_call"
                && call.arguments["id"] == format!("native:{}", action.tool_name)
            {
                &call.arguments["arguments"]
            } else {
                continue;
            };
            if !action
                .arguments
                .iter()
                .all(|(key, value)| args.get(key) == Some(value))
            {
                continue;
            }
            let record = self
                .journal
                .find_for_turn(turn.into(), call.call_id)
                .await?;
            let Some(result) = record
                .filter(|r| r.status == "completed")
                .and_then(|r| r.result)
            else {
                continue;
            };
            let result: Value = result.read().map_err(|error| {
                BtccError::relayed("capability_recovery_result_invalid", error.to_string())
            })?;
            if result["ok"] == true || result["error"]["code"] == "authority_request_denied" {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(super) fn instruction(&self) -> String {
        format!(
            "The child lacked {} but this parent has it. Complete the requested action here in this Turn through the normal approval path (or delegate with that capability granted). Reuse and revise the parent Plan to direct execution. A prose-only capability failure cannot finish this job. Requested action: {}",
            self.handoff.requested_action.tool_name,
            serde_json::to_string(&self.handoff.requested_action).unwrap_or_default()
        )
    }
}
