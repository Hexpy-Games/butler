//! In-process publication epoch. Notifications cover durable source/queue writes
//! that precede the consumer's writer lease; no scan, worker or disk write.
use std::sync::atomic::{AtomicU64, Ordering};

static PUBLICATIONS: AtomicU64 = AtomicU64::new(0);

pub(super) fn published_revision() -> u64 {
    PUBLICATIONS.load(Ordering::Acquire)
}

pub(crate) fn signal_inventory_change() {
    PUBLICATIONS.fetch_add(1, Ordering::AcqRel);
}
