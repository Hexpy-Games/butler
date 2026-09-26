//! Per-Turn journal policy and ordinary activity binding.

use std::sync::Arc;

use crate::btcc::ToolJournalRepository;
use crate::btcc::{
    BtccError, GuidedInvocation, JournalCloseout, JournalPort, ModelRoundMessage,
    ModelRoundToolCall, PortFuture, SuspensionReason, TextCallDisposition, ToolOutcome, ToolResult,
};

use super::guided_activity::NativeGuidedActivity;
mod closeout;

pub(crate) struct NativeGuidedJournal {
    turn_id: String,
    journal: Arc<ToolJournalRepository>,
    activity: Arc<NativeGuidedActivity>,
}

impl NativeGuidedJournal {
    pub(crate) fn new(
        turn_id: String,
        journal: Arc<ToolJournalRepository>,
        activity: Arc<NativeGuidedActivity>,
    ) -> Self {
        Self {
            turn_id,
            journal,
            activity,
        }
    }

    fn check_turn(&self, invocation: GuidedInvocation<'_>) -> Result<(), BtccError> {
        if invocation.turn.turn_id == self.turn_id {
            Ok(())
        } else {
            Err(BtccError::relayed(
                "guided_journal_turn_mismatch",
                "Journal owner belongs to a different Turn",
            ))
        }
    }
}

impl JournalPort for NativeGuidedJournal {
    fn handle_text_tool_calls<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        _: &'a [String],
        _: &'a [ModelRoundToolCall],
        _: &'a str,
        _: u32,
    ) -> PortFuture<'a, TextCallDisposition> {
        Box::pin(async move {
            self.check_turn(invocation)?;
            Ok(TextCallDisposition::Fail(BtccError::relayed(
                "guided_text_tool_call_unsupported",
                "Use the selected structured tool definition",
            )))
        })
    }

    fn synthesize_final<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        _: &'a [ModelRoundMessage],
        _: u32,
    ) -> PortFuture<'a, String> {
        Box::pin(async move {
            self.check_turn(invocation)?;
            Err(BtccError::relayed(
                "guided_final_synthesis_unbound",
                "Native final synthesis requires a configured model owner",
            ))
        })
    }

    fn accept_tool_candidate<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        _: &'a str,
    ) -> PortFuture<'a, bool> {
        Box::pin(async move {
            self.check_turn(invocation)?;
            Ok(false)
        })
    }

    fn assistant_before_tools<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
        calls: &'a [ModelRoundToolCall],
        _: u32,
    ) -> PortFuture<'a, ()> {
        Box::pin(async move {
            self.check_turn(invocation)?;
            self.activity.observe_batch(&self.turn_id, text, calls)
        })
    }

    fn outcome<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        _call: &'a ModelRoundToolCall,
        result: &'a ToolResult,
    ) -> PortFuture<'a, Option<ToolOutcome>> {
        Box::pin(async move {
            self.check_turn(invocation)?;
            let pending = result.output.as_ref().is_some_and(|value| {
                value.field("authority_pending").ok().flatten() == Some("true")
            });
            Ok(pending.then_some(ToolOutcome::Suspend(SuspensionReason::AuthorityPending)))
        })
    }

    fn closeout<'a>(&'a self, invocation: GuidedInvocation<'a>) -> PortFuture<'a, JournalCloseout> {
        Box::pin(async move {
            self.check_turn(invocation)?;
            closeout::collect(&self.journal, &self.turn_id).await
        })
    }
}
