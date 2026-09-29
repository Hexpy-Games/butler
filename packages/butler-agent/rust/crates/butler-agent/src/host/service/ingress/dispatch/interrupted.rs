//! Turns a crashed or replaced service process was running (owner decision:
//! such a turn is never resumed automatically; it ends failed and retryable).
//!
//! The App is told with a `turn_failed` / `turn_interrupted` report and the
//! queue record is settled. When the report cannot be delivered the record is
//! never executed instead: a transient failure defers it for another report
//! attempt, a record that can never be reported (no App target, invalid
//! envelope) is settled failed. Only a turn whose session was never bound runs:
//! BTCC never started it, so running it is not a resume.

use serde_json::json;

use super::super::{IngressDelivery, IngressError, IngressPoll, action, bind};
use butler_gateway::gateway::{ClaimedInboundEvent, InboundQueue, QueuedInboundEvent};
use butler_turn::workspace::SessionBindingStore;

/// A turn that a crashed process (dead queue claim owner) was running.
pub(super) fn by_crash(record: &QueuedInboundEvent) -> bool {
    metadata_flag(record, "recoveredFromProcessing")
        && record
            .metadata
            .get("recoveryReason")
            .and_then(serde_json::Value::as_str)
            == Some("processing_owner_dead")
        && plain_turn(record)
}

/// A turn already parked once for process replacement after an interruption.
pub(super) fn replaced_once(record: &QueuedInboundEvent) -> bool {
    metadata_flag(record, "recoveredFromRuntimeInterruption")
        && (plain_turn(record) || resume_turn(record))
}

fn metadata_flag(record: &QueuedInboundEvent, key: &str) -> bool {
    record
        .metadata
        .get(key)
        .and_then(serde_json::Value::as_bool)
        == Some(true)
}

fn plain_turn(record: &QueuedInboundEvent) -> bool {
    bind::Envelope::from_record(record).is_ok_and(|envelope| envelope.control.is_none())
}

/// A control record resuming an admitted turn (after an authority decision).
fn resume_turn(record: &QueuedInboundEvent) -> bool {
    bind::Envelope::from_record(record).is_ok_and(|envelope| {
        envelope
            .control
            .as_ref()
            .and_then(|control| control.get("kind"))
            .and_then(serde_json::Value::as_str)
            == Some("resume_turn")
    })
}

/// What a failed interruption report means for the queue record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ReportFailure {
    /// The session was never bound, so BTCC never started the turn.
    NeverStarted,
    /// The record can never be reported (or run): settle it failed.
    Unreportable,
    /// Report again later.
    Transient,
}

impl ReportFailure {
    pub(super) fn of(code: &str) -> Self {
        match code {
            "session_binding_missing" => Self::NeverStarted,
            "inbound_envelope_invalid"
            | "inbound_app_turn_invalid"
            | "inbound_app_target_missing"
            | "native_transport_unavailable" => Self::Unreportable,
            _ => Self::Transient,
        }
    }
}

/// Reports the interrupted turn to the App as failed and retryable
/// (`turn_interrupted`) and settles the queue record with `status`. The turn
/// keeps its durable state, so `/retry` resumes it without running finished
/// tool effects again. `None` only when the turn never started and may run.
pub(super) async fn settle(
    item: &ClaimedInboundEvent,
    queue: &InboundQueue,
    bindings: &SessionBindingStore,
    delivery: &dyn IngressDelivery,
    status: &str,
) -> Option<IngressPoll> {
    let error = match report(item, bindings, delivery, None).await {
        Ok(()) => {
            let completed = queue.complete(
                item,
                json!({
                    "source":"gateway/btcc/btcc-inbound-dispatcher.ts",
                    "dispatchStatus":status,"handled":true,"delivered":1,
                }),
            );
            return Some(poll(matches!(completed, Ok(true)), 1));
        }
        Err(error) => error,
    };
    eprintln!(
        "[native-btcc] interruption report unavailable code={}",
        error.code
    );
    match ReportFailure::of(error.code) {
        ReportFailure::NeverStarted => None,
        ReportFailure::Unreportable => {
            let failed = queue.fail(
                item,
                error.code,
                json!({
                    "source":"gateway/btcc/btcc-inbound-dispatcher.ts",
                    "dispatchStatus":format!("{status}-unreported"),"handled":false,
                }),
            );
            Some(IngressPoll {
                failed: usize::from(matches!(failed, Ok(true))),
                ..Default::default()
            })
        }
        // Not an interruption of this process: the service keeps running and
        // claims the record again once its backoff has passed.
        ReportFailure::Transient => {
            let _ = queue.defer(item, error.code);
            Some(IngressPoll::default())
        }
    }
}

/// Tells the App the turn failed: interrupted, or `rejected` with that code.
pub(super) async fn report(
    item: &ClaimedInboundEvent,
    bindings: &SessionBindingStore,
    delivery: &dyn IngressDelivery,
    rejected: Option<&str>,
) -> Result<(), IngressError> {
    let envelope = bind::Envelope::from_record(&item.record)?;
    let binding = bind::existing_control_binding(&envelope, bindings).await?;
    let report = match rejected {
        Some(code) => action::rejected(item, &envelope, &binding, code)?,
        None => action::crash_interrupted(item, &envelope, &binding)?,
    };
    if delivery.deliver(binding.session_id.clone(), report).await? {
        Ok(())
    } else {
        Err(IngressError::new(
            "inbound_delivery_interrupted",
            "App result delivery unavailable",
        ))
    }
}

fn poll(settled: bool, delivered: usize) -> IngressPoll {
    if settled {
        IngressPoll {
            handled: 1,
            delivered,
            ..Default::default()
        }
    } else {
        IngressPoll {
            interrupted: 1,
            ..Default::default()
        }
    }
}
