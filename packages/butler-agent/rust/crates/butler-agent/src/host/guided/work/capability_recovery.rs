//! After a child's capability hand-back, the parent gets one correction to run the handed-back action.
use butler_turn::btcc::{BtccError, CapabilityHandoff, ToolJournalRepository};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// Delivered once per turn execution.
pub(super) struct CapabilityRecovery {
    handoff: CapabilityHandoff,
    journal: Arc<ToolJournalRepository>,
    delivered: AtomicBool,
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
            .then_some(Self {
                handoff,
                journal,
                delivered: AtomicBool::new(false),
            })
    }

    async fn pending(&self, turn: &str) -> Result<bool, BtccError> {
        // Identity-only query scoped to this Turn; arguments are hints, not authority.
        let name = &self.handoff.requested_action.tool_name;
        for call in self.journal.list_signatures(turn.into()).await? {
            if call.tool_name != *name
                && !(call.tool_name == "tool_call"
                    && call.arguments["id"] == format!("native:{name}"))
            {
                continue;
            }
            let record = self
                .journal
                .find_for_turn(turn.into(), call.call_id)
                .await?;
            if record.is_some_and(|r| r.status == "completed") {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(super) async fn take_instruction(&self, turn: &str) -> Result<Option<String>, BtccError> {
        if self.delivered.load(Ordering::SeqCst) || !self.pending(turn).await? {
            return Ok(None);
        }
        if self.delivered.swap(true, Ordering::SeqCst) {
            return Ok(None);
        }
        Ok(Some(self.instruction()))
    }

    pub(super) fn instruction(&self) -> String {
        format!(
            "The child lacked {} but this parent has it. Complete the requested action here in this Turn through the normal approval path (or delegate with that capability granted). Reuse and revise the parent Plan to direct execution. Requested action: {}",
            self.handoff.requested_action.tool_name,
            serde_json::to_string(&self.handoff.requested_action).unwrap_or_default()
        )
    }
}
