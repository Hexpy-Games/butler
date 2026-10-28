use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

#[derive(Clone, Default)]
pub(crate) struct KeyedLocks(Arc<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>>);

impl KeyedLocks {
    pub(crate) async fn acquire(&self, key: String) -> OwnedMutexGuard<()> {
        self.lock(key).lock_owned().await
    }

    pub(crate) fn try_acquire(&self, key: String) -> Option<OwnedMutexGuard<()>> {
        self.lock(key).try_lock_owned().ok()
    }

    fn lock(&self, key: String) -> Arc<AsyncMutex<()>> {
        let mut locks = self.0.lock();
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(AsyncMutex::new(()));
            locks.insert(key, Arc::downgrade(&lock));
            lock
        }
    }
}
