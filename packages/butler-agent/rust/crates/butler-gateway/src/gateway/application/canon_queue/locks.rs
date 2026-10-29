//! Wake durable replay only after every projection/delivery guard is released.
use super::*;
use tokio::sync::OwnedMutexGuard;

pub(super) struct ReplayLocks<'a> {
    app: &'a AppApplication,
    guards: Vec<OwnedMutexGuard<()>>,
}
impl<'a> ReplayLocks<'a> {
    pub(super) fn new(app: &'a AppApplication) -> Self {
        Self {
            app,
            guards: Vec::new(),
        }
    }

    pub(super) async fn acquire(&mut self, key: String) {
        self.guards
            .push(self.app.canon_projection_locks.acquire(key).await);
    }
}
impl Drop for ReplayLocks<'_> {
    fn drop(&mut self) {
        if !self.guards.is_empty() {
            self.guards.clear();
            self.app.dependencies.canon.wake_replay();
        }
    }
}
