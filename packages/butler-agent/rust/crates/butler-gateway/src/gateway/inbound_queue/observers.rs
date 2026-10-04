//! Owned notifications after a terminal queue record is durable.
use parking_lot::Mutex;
use std::sync::Arc;

pub type InboundSettlementListener = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
pub(super) struct Observers(Mutex<Vec<InboundSettlementListener>>);

impl std::fmt::Debug for Observers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettlementObservers")
            .finish_non_exhaustive()
    }
}

impl Observers {
    pub(super) fn add(&self, observer: InboundSettlementListener) {
        self.0.lock().push(observer);
    }

    pub(super) fn settled(&self, accepted: bool) {
        if accepted {
            for observer in self.0.lock().iter() {
                observer();
            }
        }
    }
}
