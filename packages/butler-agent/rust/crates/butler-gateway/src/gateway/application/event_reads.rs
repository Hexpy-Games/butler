//! Event transport reads shared by gateway trait adapters.
use super::{AppApplication, app_error, events};
use crate::gateway::{AppEventEnvelope, ApplicationFuture};

impl AppApplication {
    pub(super) fn event_cursor_read(&self) -> ApplicationFuture<u64> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(|connection| events::latest(connection))
                .await
                .map_err(app_error)
        })
    }

    pub(super) fn event_replay_read(
        &self,
        after: f64,
        limit: usize,
    ) -> ApplicationFuture<Vec<AppEventEnvelope>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(move |db| events::replay(db, after, limit))
                .await
                .map_err(app_error)
        })
    }
}
