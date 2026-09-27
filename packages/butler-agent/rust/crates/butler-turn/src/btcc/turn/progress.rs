use crate::btcc::{AgentLoopProgress, PortFuture, ProgressDestination, RuntimeTurnEventInput};

use super::contracts::ProgressWrite;
use super::ports::{PreparedConversation, ProgressEventRepository};

pub(super) struct TurnProgressScope<'a> {
    pub(super) conversation: &'a dyn PreparedConversation,
    pub(super) repository: &'a dyn ProgressEventRepository,
    pub(super) session_id: &'a str,
    pub(super) turn_id: &'a str,
    pub(super) destination: &'a ProgressDestination,
}

impl AgentLoopProgress for TurnProgressScope<'_> {
    fn emit(&self, event: RuntimeTurnEventInput) -> PortFuture<'_, ()> {
        Box::pin(async move {
            // Provider stream frames (streamed answer text) are display only:
            // the conversation never admits them, so they skip its store and
            // each frame is written once, to the progress repository.
            if !event.kind.starts_with("model.stream.") {
                self.conversation.record_event(&event).await?;
            }
            self.repository
                .append(ProgressWrite {
                    session_id: self.session_id.into(),
                    turn_id: self.turn_id.into(),
                    destination: self.destination.clone(),
                    event,
                })
                .await
        })
    }
}
