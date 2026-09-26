//! BTCC's adapter owns one canonical Conversation admission for this execution.

use crate::btcc::{
    BtccError, EventVisibility, PortFuture, PreparedConversation, RuntimeTurnEventInput,
    TurnOutcome, TurnOutcomeKind,
};
use crate::conversation::{
    AdmissionEventVisibility, AgentConversationStore, ConversationAdmissionTurn,
    RuntimeAdmissionEvent, TurnOutcomeKind as ConversationOutcome,
};

pub(super) struct ConversationProjection {
    admission: ConversationAdmissionTurn,
    store: AgentConversationStore,
    turn_id: String,
}

impl ConversationProjection {
    pub(super) fn new(
        admission: ConversationAdmissionTurn,
        store: AgentConversationStore,
        turn_id: String,
    ) -> Self {
        Self {
            admission,
            store,
            turn_id,
        }
    }
}

impl PreparedConversation for ConversationProjection {
    fn record_event<'a>(&'a self, event: &'a RuntimeTurnEventInput) -> PortFuture<'a, ()> {
        Box::pin(async move {
            self.admission
                .record_event(RuntimeAdmissionEvent {
                    kind: &event.kind,
                    payload: event.payload.as_ref(),
                    visibility: event.visibility.map(|visibility| match visibility {
                        EventVisibility::Internal => AdmissionEventVisibility::Internal,
                        EventVisibility::Public => AdmissionEventVisibility::Public,
                    }),
                })
                .await
                .map_err(BtccError::from)
        })
    }

    fn complete(&self, outcome: TurnOutcome) -> PortFuture<'_, ()> {
        Box::pin(async move {
            // The existing prepare-turn completion adapter checks the durable
            // outcome before admission, preserving replay without a new generation.
            if self
                .store
                .read_turn_outcome(&self.turn_id)
                .await
                .map_err(BtccError::from)?
                .is_some_and(|outcome| outcome.outcome == ConversationOutcome::Delivered)
            {
                return Ok(());
            }
            let (message_id, content) = match outcome.result {
                TurnOutcomeKind::Delivered(value) => (value.message_id, value.content),
                TurnOutcomeKind::AlreadyDelivered(value) => (value.message_id, value.content),
                _ => {
                    return Err(BtccError::new(
                        "conversation_outcome_invalid",
                        "Conversation completion requires delivered outcome",
                    ));
                }
            };
            self.admission
                .admit_final(&content, &format!("btcc-canonical-final:{message_id}"))
                .await
                .map_err(BtccError::from)?;
            self.admission
                .finalize("complete", &self.store.identity_clock().now_iso())
                .await
                .map_err(BtccError::from)
        })
    }

    fn cancel(&self) -> PortFuture<'_, ()> {
        Box::pin(async move {
            if self
                .store
                .read_turn_outcome(&self.turn_id)
                .await
                .map_err(BtccError::from)?
                .is_some_and(|outcome| outcome.outcome == ConversationOutcome::Cancelled)
            {
                return Ok(());
            }
            self.admission
                .finalize("aborted", &self.store.identity_clock().now_iso())
                .await
                .map_err(BtccError::from)
        })
    }
}

#[cfg(test)]
mod tests;
