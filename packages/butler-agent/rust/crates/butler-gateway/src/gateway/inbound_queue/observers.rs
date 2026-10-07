//! Owned notifications after a terminal queue record is durable.
use parking_lot::Mutex;
use std::sync::Arc;

pub type InboundEnqueueListener = Arc<dyn Fn(&butler_core::json::JsonDocument) + Send + Sync>;

pub type InboundSettlementListener = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
pub(super) struct Observers(Mutex<Vec<InboundSettlementListener>>);

#[derive(Default)]
pub(super) struct EnqueueObservers(Mutex<Vec<InboundEnqueueListener>>);
impl std::fmt::Debug for EnqueueObservers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnqueueObservers").finish_non_exhaustive()
    }
}
impl EnqueueObservers {
    pub(super) fn add(&self, listener: InboundEnqueueListener) {
        self.0.lock().push(listener);
    }
    pub(super) fn enqueued(&self, document: &butler_core::json::JsonDocument) {
        for listener in self.0.lock().iter() {
            listener(document);
        }
    }
}

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
