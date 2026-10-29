use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

#[derive(Default)]
struct Lock {
    mutex: Arc<AsyncMutex<()>>,
    skipped: Mutex<bool>,
}

pub(crate) struct KeyedGuard {
    guard: OwnedMutexGuard<()>,
    lock: Arc<Lock>,
}
impl KeyedGuard {
    /// Serialize skip registration with unlock so neither side can miss a retry.
    pub(crate) fn release(self) -> bool {
        let mut skipped = self.lock.skipped.lock();
        drop(self.guard);
        std::mem::take(&mut *skipped)
    }
}

#[derive(Clone, Default)]
pub(crate) struct KeyedLocks(Arc<Mutex<HashMap<String, Weak<Lock>>>>);

impl KeyedLocks {
    pub(crate) async fn acquire(&self, key: String) -> KeyedGuard {
        let lock = self.lock(key);
        let guard = lock.mutex.clone().lock_owned().await;
        KeyedGuard { guard, lock }
    }

    /// Only replay skips locks; their ReplayLocks holder consumes this flag.
    pub(crate) fn try_acquire(&self, key: String) -> Option<KeyedGuard> {
        let lock = self.lock(key);
        let mut skipped = lock.skipped.lock();
        match lock.mutex.clone().try_lock_owned() {
            Ok(guard) => {
                drop(skipped);
                Some(KeyedGuard { guard, lock })
            }
            Err(_) => {
                *skipped = true;
                None
            }
        }
    }

    fn lock(&self, key: String) -> Arc<Lock> {
        let mut locks = self.0.lock();
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(Lock::default());
            locks.insert(key, Arc::downgrade(&lock));
            lock
        }
    }
}
