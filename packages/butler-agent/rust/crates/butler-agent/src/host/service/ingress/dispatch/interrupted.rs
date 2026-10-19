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
use butler_turn::btcc::{BtccCode, SubsessionService};
use butler_turn::workspace::SessionBindingStore;

/// The stable code an interrupted internal child turn reports to its parent.
const CHILD_INTERRUPTED: &str = "child_turn_interrupted";
/// The child end code of a turn a stop request cancelled: the child's result
/// is `cancelled`, not failed.
pub(super) const CHILD_CANCELLED: &str = "turn_cancelled";
/// Metadata naming the child failure a retained record still has to save.
const CHILD_FAILURE_PENDING: &str = "childFailurePending";

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

/// Report-only provenance after a runtime interruption, including legacy
/// records parked by a previous version for process replacement.
pub(super) fn replaced_once(record: &QueuedInboundEvent) -> bool {
    metadata_flag(record, "recoveredFromRuntimeInterruption")
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

/// How the run of an internal child turn that ended with `error` closes the
/// child. A run a stop request cancelled ends `cancelled`, the same result the
/// queued stop records (the first saved result is kept), so whichever of the
/// two settles first answers the parent truthfully. Any other error, and a
/// failed stop itself, ends the child failed as interrupted.
pub(super) fn child_end_code(item: &ClaimedInboundEvent, error: &IngressError) -> &'static str {
    let stopped = error.code == "inbound_turn_interrupted"
        && error.message == BtccCode::TurnCancelled.as_str()
        && bind::Envelope::from_record(&item.record).is_ok_and(|envelope| {
            envelope
                .control
                .as_ref()
                .and_then(|control| control.get("kind"))
                .and_then(serde_json::Value::as_str)
                != Some("cancel_turn")
        });
    if stopped {
        CHILD_CANCELLED
    } else {
        CHILD_INTERRUPTED
    }
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

/// Settles an interrupted turn. An internal child turn first ends failed, so
/// its parent receives the result through the normal follow-up path instead
/// of waiting on a child that will not run again by itself.
pub(super) async fn settle_returning_child(
    item: &ClaimedInboundEvent,
    queue: &InboundQueue,
    bindings: &SessionBindingStore,
    delivery: &dyn IngressDelivery,
    subsessions: &SubsessionService,
    status: &str,
) -> Option<IngressPoll> {
    settle_closing_child(
        item,
        queue,
        bindings,
        delivery,
        subsessions,
        status,
        CHILD_INTERRUPTED,
    )
    .await
}

/// Settles an interrupted turn after ending an internal child turn with
/// `code` (or the end a retained record still has to save).
pub(super) async fn settle_closing_child(
    item: &ClaimedInboundEvent,
    queue: &InboundQueue,
    bindings: &SessionBindingStore,
    delivery: &dyn IngressDelivery,
    subsessions: &SubsessionService,
    status: &str,
    code: &str,
) -> Option<IngressPoll> {
    let code = item
        .record
        .metadata
        .get(CHILD_FAILURE_PENDING)
        .and_then(serde_json::Value::as_str)
        .unwrap_or(code)
        .to_owned();
    if super::rejected::close_child(item, bindings, subsessions, &code).await
        == super::rejected::ChildClose::Pending
    {
        return Some(retry_child_close(item, queue, &code).await);
    }
    settle(item, queue, bindings, delivery, status).await
}

/// The child's failed result could not be saved yet. The record stays queued
/// as report-only (its turn never runs again), and a later claim saves the
/// result: the same durable deferral an undeliverable interruption report uses.
pub(super) async fn retry_child_close(
    item: &ClaimedInboundEvent,
    queue: &InboundQueue,
    code: &str,
) -> IngressPoll {
    let mut retained = item.clone();
    let metadata = &mut retained.record.metadata;
    metadata.insert("recoveredFromRuntimeInterruption".into(), true.into());
    metadata.insert(CHILD_FAILURE_PENDING.into(), code.into());
    let _ = queue
        .defer_async(retained, "child_result_pending".into())
        .await;
    IngressPoll::default()
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
    // Child sessions publish through BTCC and have no App turn delivery
    // target; their parent receives the result (settle_closing_child).
    if let Some(poll) = settle_child(item, queue, bindings).await {
        return Some(poll);
    }
    let error = match report(item, bindings, delivery, None).await {
        Ok(()) => {
            let completed = queue
                .complete_async(
                    item.clone(),
                    json!({
                        "source":"gateway/btcc/btcc-inbound-dispatcher.ts",
                        "dispatchStatus":status,"handled":true,"delivered":1,
                    }),
                )
                .await;
            return Some(poll(matches!(completed, Ok(true)), 1));
        }
        Err(error) => error,
    };
    butler_core::diagnostic!(
        "[native-btcc] interruption report unavailable code={}",
        error.code
    );
    match ReportFailure::of(error.code) {
        ReportFailure::NeverStarted => None,
        ReportFailure::Unreportable => {
            let failed = queue
                .fail_async(
                    item.clone(),
                    error.code.to_owned(),
                    json!({
                        "source":"gateway/btcc/btcc-inbound-dispatcher.ts",
                        "dispatchStatus":format!("{status}-unreported"),"handled":false,
                    }),
                )
                .await;
            Some(IngressPoll {
                failed: usize::from(matches!(failed, Ok(true))),
                ..Default::default()
            })
        }
        ReportFailure::Transient => {
            if status == "shutdown-interrupted" {
                // Preserve interruption provenance if publication failed during
                // close: the next process must report it, never rerun the turn.
                let _ = queue.park_async(item.clone(), error.code.to_owned()).await;
            } else {
                // Retain report-only provenance while allowing this same process
                // to retry delivery after the normal queue backoff.
                let mut deferred = item.clone();
                deferred
                    .record
                    .metadata
                    .insert("recoveredFromRuntimeInterruption".into(), true.into());
                let _ = queue.defer_async(deferred, error.code.to_owned()).await;
            }
            Some(IngressPoll::default())
        }
    }
}

async fn settle_child(
    item: &ClaimedInboundEvent,
    queue: &InboundQueue,
    bindings: &SessionBindingStore,
) -> Option<IngressPoll> {
    let envelope = bind::Envelope::from_record(&item.record).ok()?;
    let binding = bind::existing_control_binding(&envelope, bindings)
        .await
        .ok()?;
    if !matches!(
        binding.role,
        butler_turn::workspace::SessionRole::Steward | butler_turn::workspace::SessionRole::Worker
    ) {
        return None;
    }
    let settled = queue
        .fail_async(
            item.clone(),
            CHILD_INTERRUPTED.into(),
            json!({"recoveredFromRuntimeInterruption":true,"sameLogicalTurnContinuation":true,
            "interruptedClaimId":item.processing.claim_id,"dispatchStatus":"child-interrupted"}),
        )
        .await;
    Some(IngressPoll {
        interrupted: usize::from(matches!(settled, Ok(true))),
        ..Default::default()
    })
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
    #[cfg(feature = "e2e-fixtures")]
    crate::host::faults::interruption_report()?;
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
