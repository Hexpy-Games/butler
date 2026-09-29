//! Turns BTCC rejected for a reason no replacement process can change.
//!
//! Running such a turn again in a new process fails the same way, so the
//! service is not replaced: the App is told the turn failed and the queue
//! record is settled failed.

use serde_json::json;

use super::super::{IngressDelivery, IngressPoll};
use super::interrupted::{self, ReportFailure};
use butler_gateway::gateway::{ClaimedInboundEvent, InboundQueue};
use butler_turn::btcc::{BtccCode, BtccError, StorageCode};
use butler_turn::workspace::SessionBindingStore;

/// The queue error of a turn BTCC rejected for good.
pub(super) const REJECTED: &str = "inbound_turn_rejected";

/// Whether `error` names a turn that no retry can run: its stored
/// admission and the request contradict each other, or it was never admitted.
pub(super) fn is_rejection(error: &BtccError) -> bool {
    [
        BtccCode::TurnReplayConflict.as_str(),
        BtccCode::TurnReplayModelInvalid.as_str(),
        StorageCode::TurnNotAdmitted.as_str(),
    ]
    .contains(&error.code())
}

/// Reports `code` to the App as a failed turn and fails the queue record. A
/// report that could not be delivered for now defers the record instead.
pub(super) async fn settle(
    item: &ClaimedInboundEvent,
    queue: &InboundQueue,
    bindings: &SessionBindingStore,
    delivery: &dyn IngressDelivery,
    code: &str,
) -> IngressPoll {
    if let Err(error) = interrupted::report(item, bindings, delivery, Some(code)).await {
        eprintln!(
            "[native-btcc] rejection report unavailable code={}",
            error.code
        );
        if ReportFailure::of(error.code) == ReportFailure::Transient {
            let _ = queue.defer(item, error.code);
            return IngressPoll::default();
        }
    }
    let failed = queue.fail(
        item,
        code,
        json!({
            "source":"gateway/btcc/btcc-inbound-dispatcher.ts",
            "dispatchStatus":"turn-rejected","handled":false,
        }),
    );
    IngressPoll {
        failed: usize::from(matches!(failed, Ok(true))),
        ..Default::default()
    }
}
