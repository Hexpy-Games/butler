//! Wake skipped replay only after every projection/delivery guard is released.
use super::super::keyed_locks::KeyedGuard;
use super::*;

pub(super) struct ReplayLocks<'a> {
    app: &'a AppApplication,
    guards: Vec<KeyedGuard>,
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
        let mut skipped = false;
        for guard in self.guards.drain(..) {
            skipped |= guard.release();
        }
        if skipped {
            self.app.dependencies.canon.wake_replay();
        }
    }
}
