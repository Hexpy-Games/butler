//! Source-ordered App actions from one authoritative BTCC outcome.

mod control;
mod rich;
mod terminal;
#[cfg(test)]
mod tests;

use serde_json::{Map, Value, json};

use super::{
    NativeIngressError,
    bind::{self, Envelope},
};
use crate::{
    btcc::{TurnOutcome, TurnOutcomeKind},
    gateway::ClaimedInboundEvent,
    workspace::{SessionTransportBinding, StoredSessionBinding},
};

pub(super) fn actions(
    item: &ClaimedInboundEvent,
    envelope: &Envelope,
    binding: &StoredSessionBinding,
    outcome: &TurnOutcome,
) -> Result<Vec<Value>, NativeIngressError> {
    let target = app_target(binding, envelope).ok_or_else(|| {
        NativeIngressError::new(
            "inbound_app_target_missing",
            "App delivery target unavailable",
        )
    })?;
    let mut projected = Vec::with_capacity(2);
    if let Some(ack) = control::ack(item, envelope, target, &outcome.result) {
        projected.push(ack);
    }
    // Source cancel handler emits only its acknowledgement when the target Turn
    // was already delivered. The original final result retains its own action.
    let cancelling = envelope
        .control
        .as_ref()
        .and_then(|control| control.get("kind"))
        .and_then(Value::as_str)
        == Some("cancel_turn");
    if cancelling && matches!(outcome.result, TurnOutcomeKind::AlreadyDelivered(_)) {
        return Ok(projected);
    }

    let terminal = if cancelling {
        terminal::cancelled(bind::routed_turn_id(envelope))
    } else {
        terminal::from_outcome(&outcome.result)?
    };
    let artifacts = rich::artifacts(terminal.artifacts);
    let changed_files = rich::changed_files(terminal.changed_files);
    let plan = rich::plan(terminal.plan);
    let no_visible = crate::public_text::trim_js_whitespace(terminal.text).is_empty()
        && artifacts.is_empty()
        && changed_files.is_empty()
        && plan.is_none();
    if no_visible && !has_valid_claim(envelope) {
        return Ok(projected);
    }
    projected.push(terminal::action(
        item,
        envelope,
        target,
        terminal,
        terminal::RichTerminal {
            artifacts,
            changed_files,
            plan,
            no_visible,
        },
    ));
    Ok(projected)
}

fn base_metadata(item: &ClaimedInboundEvent, envelope: &Envelope) -> Map<String, Value> {
    let mut metadata = Map::new();
    metadata.insert(
        "source".into(),
        "gateway/btcc/btcc-inbound-dispatcher.ts".into(),
    );
    metadata.insert("queueId".into(), item.record.queue_id.clone().into());
    metadata.insert(
        "dispatchClaimId".into(),
        item.processing.claim_id.clone().into(),
    );
    if let Some(claim) = envelope
        .routing_hints
        .as_ref()
        .and_then(|hints| hints.app_queue_claim_id.as_deref())
        .filter(|claim| valid_claim(claim))
    {
        metadata.insert("appQueueClaimId".into(), claim.into());
        metadata.insert(
            "appQueueClaimProvenance".into(),
            "matching_app_target".into(),
        );
    }
    metadata
}

fn peer(target: &SessionTransportBinding) -> Value {
    if let Some(thread_id) = &target.thread_id {
        json!({"kind":"thread","id":target.peer_id,"threadId":thread_id})
    } else {
        json!({"kind":"dm","id":target.peer_id})
    }
}

fn app_target<'a>(
    binding: &'a StoredSessionBinding,
    envelope: &Envelope,
) -> Option<&'a SessionTransportBinding> {
    binding
        .transport_bindings
        .iter()
        .find(|target| {
            target.transport == "app"
                && target.account_id == envelope.account_id
                && target.peer_id == envelope.peer.id
                && target.thread_id.is_none()
        })
        .or_else(|| {
            (envelope.transport == "automation")
                .then(|| {
                    binding
                        .transport_bindings
                        .iter()
                        .find(|target| target.transport == "app")
                })
                .flatten()
        })
}

fn has_valid_claim(envelope: &Envelope) -> bool {
    envelope
        .routing_hints
        .as_ref()
        .and_then(|hints| hints.app_queue_claim_id.as_deref())
        .is_some_and(valid_claim)
}

fn valid_claim(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 96
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | ':' | '.' | '/' | '-'))
}
