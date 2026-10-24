//! Transition-triggered atomic persistence, serialized off async workers.
use super::PersistedQuota;
use parking_lot::Mutex;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
pub(super) struct Persistence {
    path: PathBuf,
    next: AtomicU64,
    written: Arc<Mutex<u64>>,
}
impl Persistence {
    pub(super) fn new(path: PathBuf) -> Self {
        Self {
            path,
            next: AtomicU64::new(0),
            written: Arc::default(),
        }
    }
    pub(super) fn write(&self, snapshot: PersistedQuota) {
        let revision = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let path = self.path.clone();
        let written = self.written.clone();
        let persist = move || {
            let mut latest = written.lock();
            if revision <= *latest {
                return;
            }
            if let Ok(value) = serde_json::to_value(snapshot)
                && butler_core::configuration::write_json_atomic(&path, &value).is_ok()
            {
                *latest = revision;
            }
        };
        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::spawn_blocking(persist);
        } else {
            persist();
        }
    }
}
