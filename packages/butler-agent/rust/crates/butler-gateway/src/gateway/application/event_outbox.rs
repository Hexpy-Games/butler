//! Live delivery of the events a storage-lane operation appends: they reach
//! subscribers only once the transaction that wrote them has committed, in the
//! order they were appended, and before the operation's own result is
//! returned. A rolled-back transaction publishes nothing.

use std::{cell::RefCell, sync::Arc};

use rusqlite::Connection;

use super::events::EventSubscribers;
use crate::gateway::PublishedEvent;

thread_local! {
    /// Present only on the storage-lane thread, which installs it.
    static OUTBOX: RefCell<Option<Outbox>> = const { RefCell::new(None) };
}

#[derive(Default)]
struct Outbox {
    /// Appended inside a transaction that has not finished.
    open_transaction: Vec<Queued>,
    /// Committed, waiting for the operation to return.
    committed: Vec<Queued>,
}

struct Queued {
    subscribers: EventSubscribers,
    event: Arc<PublishedEvent>,
}

/// Makes this thread's connection defer event delivery until commit.
pub(super) fn install(connection: &Connection) {
    OUTBOX.with(|outbox| *outbox.borrow_mut() = Some(Outbox::default()));
    connection.commit_hook(Some(|| {
        with_outbox(|outbox| {
            let appended = std::mem::take(&mut outbox.open_transaction);
            outbox.committed.extend(appended);
        });
        false
    }));
    connection.rollback_hook(Some(|| {
        with_outbox(|outbox| outbox.open_transaction.clear());
    }));
}

/// Queues `event` for delivery after the commit that makes it durable and
/// returns `None`; hands the event back when this thread is not a storage lane,
/// so the caller delivers it at once.
pub(super) fn defer(
    connection: &Connection,
    subscribers: &EventSubscribers,
    event: Arc<PublishedEvent>,
) -> Option<Arc<PublishedEvent>> {
    let queued = Queued {
        subscribers: subscribers.clone(),
        event,
    };
    let in_transaction = !connection.is_autocommit();
    let rejected = OUTBOX.with(|outbox| {
        let mut outbox = outbox.borrow_mut();
        let Some(outbox) = outbox.as_mut() else {
            return Some(queued);
        };
        if in_transaction {
            outbox.open_transaction.push(queued);
        } else {
            outbox.committed.push(queued);
        }
        None
    });
    rejected.map(|queued| queued.event)
}

/// Queues an event whose transaction already committed (see `events::publish`).
pub(super) fn defer_committed(
    subscribers: &EventSubscribers,
    event: Arc<PublishedEvent>,
) -> Option<Arc<PublishedEvent>> {
    OUTBOX.with(|outbox| match outbox.borrow_mut().as_mut() {
        Some(outbox) => {
            outbox.committed.push(Queued {
                subscribers: subscribers.clone(),
                event,
            });
            None
        }
        None => Some(event),
    })
}

/// Delivers what the finished operation committed.
pub(super) fn flush() {
    let committed = with_outbox(|outbox| std::mem::take(&mut outbox.committed));
    for queued in committed.unwrap_or_default() {
        queued.subscribers.publish(&queued.event);
    }
}

fn with_outbox<T>(action: impl FnOnce(&mut Outbox) -> T) -> Option<T> {
    OUTBOX.with(|outbox| outbox.borrow_mut().as_mut().map(action))
}
