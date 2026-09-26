//! Cancellation acknowledgement precedes the optional terminal action.

use serde_json::{Value, json};

use super::{base_metadata, peer};
use crate::{
    btcc::TurnOutcomeKind,
    gateway::ClaimedInboundEvent,
    host::native_ingress::bind::{self, Envelope},
    workspace::SessionTransportBinding,
};

pub(super) fn ack(
    item: &ClaimedInboundEvent,
    envelope: &Envelope,
    target: &SessionTransportBinding,
    outcome: &TurnOutcomeKind,
) -> Option<Value> {
    let control = envelope.control.as_ref()?.as_object()?;
    if control.get("kind")?.as_str()? != "cancel_turn" {
        return None;
    }
    let mut metadata = base_metadata(item, envelope);
    metadata.insert("kind".into(), "turn_cancellation_ack".into());
    metadata.insert("turnId".into(), bind::routed_turn_id(envelope).into());
    if let Some(request_id) = control.get("requestId") {
        metadata.insert("requestId".into(), request_id.clone());
    }
    metadata.insert("outcome".into(), outcome_name(outcome).into());
    Some(json!({
        "actionId":format!("btcc-control-ack:{}:{}:{}:{}",envelope.event_id,
            target.transport,target.peer_id,target.thread_id.as_deref().unwrap_or("main")),
        "transport":target.transport,"accountId":target.account_id,"peer":peer(target),
        "message":{"replyToMessageId":envelope.message.id},"metadata":metadata,
    }))
}

fn outcome_name(outcome: &TurnOutcomeKind) -> &'static str {
    match outcome {
        TurnOutcomeKind::Delivered(_) => "delivered",
        TurnOutcomeKind::AlreadyDelivered(_) => "already_delivered",
        TurnOutcomeKind::Cancelled { .. } => "cancelled",
        TurnOutcomeKind::AlreadyCancelled { .. } => "already_cancelled",
        TurnOutcomeKind::AlreadyFinalizing { .. } => "already_finalizing",
        TurnOutcomeKind::FencedPendingPersistence { .. } => "fenced_pending_persistence",
        TurnOutcomeKind::Suspended { .. } => "suspended",
    }
}
