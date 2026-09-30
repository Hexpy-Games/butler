//! Items no replacement process can run: BTCC rejected the turn, or the
//! record itself is invalid.
//!
//! Running such an item again in a new process fails the same way, so the
//! service is not replaced: the App is told the turn failed, an internal
//! child turn closes its relation, and the queue record is settled failed.

use serde_json::json;

use super::super::{IngressDelivery, IngressError, IngressPoll, bind};
use super::interrupted::{self, ReportFailure};
use butler_gateway::gateway::{ClaimedInboundEvent, InboundQueue};
use butler_turn::btcc::{BtccCode, BtccError, StorageCode, SubsessionService};
use butler_turn::workspace::{SessionBindingStore, SessionRole};

/// The queue error of a turn BTCC rejected for good.
pub(super) const REJECTED: &str = "inbound_turn_rejected";

/// Ingress errors of a record that is invalid or unsupported however often
/// it is claimed.
const INVALID_RECORD: [&str; 6] = [
    "inbound_envelope_invalid",
    "inbound_app_turn_invalid",
    "inbound_control_invalid",
    "inbound_control_unsupported",
    "inbound_transport_unsupported",
    "session_binding_missing",
];

/// Whether `error` names a turn that no retry can run: its stored
/// admission and the request contradict each other, or it was never admitted.
pub(super) fn is_rejection(error: &BtccError) -> bool {
    [
        BtccCode::TurnReplayConflict.as_str(),
        StorageCode::TurnNotAdmitted.as_str(),
    ]
    .contains(&error.code())
}

/// The safe error code of an item no replacement can run, if `error` is one.
pub(super) fn safe_code(error: &IngressError) -> Option<&str> {
    if error.code == REJECTED {
        Some(&error.message)
    } else if INVALID_RECORD.contains(&error.code) {
        Some(error.code)
    } else {
        None
    }
}

/// Fails the item: the App is told the turn failed with `code` and the
/// relation of an internal child turn is closed.
pub(super) async fn reject(
    item: &ClaimedInboundEvent,
    queue: &InboundQueue,
    bindings: &SessionBindingStore,
    delivery: &dyn IngressDelivery,
    subsessions: &SubsessionService,
    code: &str,
) -> IngressPoll {
    let child = close_child(item, bindings, subsessions, code).await;
    settle(item, queue, bindings, delivery, code, child).await
}

/// Fails the queue record after telling the App (unless the item is an
/// internal child turn, which has no App transcript). A report that could not
/// be delivered for now defers the record instead.
pub(super) async fn settle(
    item: &ClaimedInboundEvent,
    queue: &InboundQueue,
    bindings: &SessionBindingStore,
    delivery: &dyn IngressDelivery,
    code: &str,
    internal_child: bool,
) -> IngressPoll {
    if !internal_child
        && let Err(error) = interrupted::report(item, bindings, delivery, Some(code)).await
    {
        eprintln!(
            "[native-btcc] rejection report unavailable code={}",
            error.code
        );
        if ReportFailure::of(error.code) == ReportFailure::Transient {
            let _ = queue.defer_async(item.clone(), error.code.to_owned()).await;
            return IngressPoll::default();
        }
    }
    let failed = queue
        .fail_async(
            item.clone(),
            code.to_owned(),
            json!({
                "source":"gateway/btcc/btcc-inbound-dispatcher.ts",
                "dispatchStatus":"turn-rejected","handled":false,
            }),
        )
        .await;
    IngressPoll {
        failed: usize::from(matches!(failed, Ok(true))),
        ..Default::default()
    }
}

/// Ends the child turn of a worker or steward session as failed, so its
/// parent relation does not stay open. `false` for any other item.
async fn close_child(
    item: &ClaimedInboundEvent,
    bindings: &SessionBindingStore,
    subsessions: &SubsessionService,
    code: &str,
) -> bool {
    let Ok(envelope) = bind::Envelope::from_record(&item.record) else {
        return false;
    };
    let Ok(binding) = bind::existing_control_binding(&envelope, bindings).await else {
        return false;
    };
    if !matches!(binding.role, SessionRole::Worker | SessionRole::Steward) {
        return false;
    }
    let summary = format!("Delegated work could not continue: {code}.");
    let turn_id = bind::routed_turn_id(&envelope);
    if let Err(error) = subsessions
        .complete_child(&binding.session_id, turn_id, "failed", summary)
        .await
    {
        eprintln!(
            "[native-btcc] rejected child result unavailable code={}",
            error.code()
        );
    }
    true
}
