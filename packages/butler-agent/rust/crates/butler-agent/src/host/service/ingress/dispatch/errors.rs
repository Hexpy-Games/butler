//! Keeps an unrecorded Stop on the durable inbound queue until BTCC can apply it.

use super::super::IngressError;
use super::rejected;
use butler_gateway::gateway::{ClaimedInboundEvent, InboundQueue};
use butler_turn::btcc::BtccError;

const STOP_NOT_PERSISTED: &str = "inbound_stop_not_persisted";

/// A BTCC error as a queue error: a rejection no replacement process can
/// change fails the item; any other error interrupts the turn.
pub(super) fn turn_error(error: &BtccError) -> IngressError {
    let code = if rejected::is_rejection(error) {
        rejected::REJECTED
    } else {
        "inbound_turn_interrupted"
    };
    IngressError::new(code, error.code())
}

/// Marks an unrecorded Stop as unacknowledged so its `cancel_turn` record can be retried.
pub(super) fn stop_persistence_error(error: &BtccError) -> IngressError {
    IngressError::new(STOP_NOT_PERSISTED, error.code())
}

/// Defers the `cancel_turn` record with 1 s doubling backoff up to 60 s; the App keeps the turn stopping until storage accepts the Stop.
pub(super) async fn defer_stop_persistence(
    item: &ClaimedInboundEvent,
    queue: &InboundQueue,
    error: &IngressError,
) -> bool {
    if error.code != STOP_NOT_PERSISTED {
        return false;
    }
    let _ = queue.defer_async(item.clone(), error.code.to_owned()).await;
    true
}
