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
            self.conversation.record_event(&event).await?;
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
