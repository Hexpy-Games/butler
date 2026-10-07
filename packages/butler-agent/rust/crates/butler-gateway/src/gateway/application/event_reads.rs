//! Event transport operations shared by gateway trait adapters.
use super::{AppApplication, app_error, events};
use crate::gateway::{AppEventEnvelope, ApplicationFuture};
use serde_json::Value;

impl AppApplication {
    pub(super) fn publish_gateway_event_owned(
        &self,
        event_type: &'static str,
        payload: serde_json::Map<String, Value>,
    ) -> ApplicationFuture<()> {
        let storage = self.storage.clone();
        let subscribers = self.subscribers.clone();
        let now = self.dependencies.identity_clock.now_iso();
        Box::pin(async move {
            storage
                .execute(move |db| {
                    events::append(db, &subscribers, event_type, None, payload, &now).map(drop)
                })
                .await
                .map_err(app_error)
        })
    }
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
