//! Items no replacement process can run: BTCC rejected the turn, or the
//! record itself is invalid.
//!
//! Running such an item again in a new process fails the same way, so the
//! service is not replaced: the App is told the turn failed, an internal
//! child turn closes its relation, and the queue record is settled failed.
//! An unsaved child failure defers the record for another close attempt.

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
        BtccCode::AuthorityContinuationMissing.as_str(),
        BtccCode::AuthoritySourceCallMissing.as_str(),
        StorageCode::AuthoritySourceCallMismatch.as_str(),
        StorageCode::AuthoritySourceCallNotPending.as_str(),
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

/// What closing an internal child turn did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ChildClose {
    /// Not a Worker or Steward turn.
    NotChild,
    /// The child turn's result is saved (now or earlier), or it has no parent.
    Closed,
    /// The failed result could not be saved yet; the record must be retried.
    Pending,
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
    match close_child(item, bindings, subsessions, code).await {
        ChildClose::Pending => interrupted::retry_child_close(item, queue, code).await,
        child => {
            settle(
                item,
                queue,
                bindings,
                delivery,
                code,
                child == ChildClose::Closed,
            )
            .await
        }
    }
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
        butler_core::diagnostic!(
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

/// Ends the child turn of a worker or steward session as failed with `code`
/// (or cancelled for `CHILD_CANCELLED`), so its parent relation does not stay
/// open.
pub(super) async fn close_child(
    item: &ClaimedInboundEvent,
    bindings: &SessionBindingStore,
    subsessions: &SubsessionService,
    code: &str,
) -> ChildClose {
    let Ok(envelope) = bind::Envelope::from_record(&item.record) else {
        return ChildClose::NotChild;
    };
    let Ok(binding) = bind::existing_control_binding(&envelope, bindings).await else {
        return ChildClose::NotChild;
    };
    if !matches!(binding.role, SessionRole::Worker | SessionRole::Steward) {
        return ChildClose::NotChild;
    }
    let turn_id = bind::routed_turn_id(&envelope);
    let closed = if code == interrupted::CHILD_CANCELLED {
        let summary = super::CANCELLED_SUMMARY.into();
        subsessions
            .complete_child(&binding.session_id, turn_id, "cancelled", summary)
            .await
    } else {
        subsessions
            .complete_failed_child(&binding.session_id, turn_id, code)
            .await
    };
    let Err(error) = closed else {
        return ChildClose::Closed;
    };
    butler_core::diagnostic!(
        "[native-btcc] child result unavailable code={}",
        error.code()
    );
    if error.code() == BtccCode::SubsessionRelationMissing.as_str()
        || subsessions
            .child_turn_closed(&binding.session_id, turn_id)
            .await
            .unwrap_or(false)
    {
        return ChildClose::Closed;
    }
    ChildClose::Pending
}
