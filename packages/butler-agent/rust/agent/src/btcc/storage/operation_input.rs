//! Owned SQL inputs exclude unrelated model context and conversation history.

use crate::btcc::{
    DeliveryOutbox, SuspensionReason, TurnCheckpoint, TurnRecord, TurnSemanticState,
};

pub(super) struct TurnVersion {
    pub turn_id: String,
    pub semantic_state: TurnSemanticState,
    pub revision: u64,
    pub execution_fence: u64,
    pub checkpoint: Option<TurnCheckpoint>,
    pub suspension: Option<SuspensionReason>,
    pub delivery_outbox: Option<DeliveryIdentity>,
}

pub(super) struct DeliveryIdentity {
    pub outbox_id: String,
}

impl From<&TurnRecord> for TurnVersion {
    fn from(turn: &TurnRecord) -> Self {
        Self {
            turn_id: turn.turn_id.clone(),
            semantic_state: turn.semantic_state,
            revision: turn.revision,
            execution_fence: turn.execution_fence,
            checkpoint: turn.checkpoint.clone(),
            suspension: turn.suspension,
            delivery_outbox: turn
                .delivery_outbox
                .as_ref()
                .map(|outbox| DeliveryIdentity {
                    outbox_id: outbox.outbox_id.clone(),
                }),
        }
    }
}

pub(super) struct CanonicalDelivery {
    pub turn_id: String,
    pub session_id: String,
    pub delivery_outbox: Option<DeliveryOutbox>,
}

impl From<&TurnRecord> for CanonicalDelivery {
    fn from(turn: &TurnRecord) -> Self {
        Self {
            turn_id: turn.turn_id.clone(),
            session_id: turn.session_id.clone(),
            delivery_outbox: turn.delivery_outbox.clone(),
        }
    }
}
