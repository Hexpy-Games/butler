//! Release a delivery claim even when its request future is cancelled.
//! A claim is taken only when the row is due, and a release without posting writes the retry deadline in the same update, so one attempt is never sent twice before its failure is recorded.
use super::super::{AppStorageError, storage::AppStorage};

pub(in crate::gateway::application) struct Reservation {
    storage: AppStorage,
    clock: std::sync::Arc<dyn crate::gateway::AppIdentityClock>,
    id: String,
    runtime: tokio::runtime::Handle,
    attempts: u32,
    queue: super::super::queue_dispatcher::QueueWake,
}
impl Reservation {
    pub(in crate::gateway::application) async fn claim(
        app: &super::super::AppApplication,
        id: String,
    ) -> Result<Option<Self>, AppStorageError> {
        let storage = app.storage.clone();
        let owner = storage.clone();
        let queue = app.queue_wake.clone();
        let runtime = tokio::runtime::Handle::current();
        let clock = app.dependencies.identity_clock.clone();
        let now = clock.now_iso();
        storage.execute(move |db| {
            let changed = db.execute("UPDATE app_initiated_messages SET posting=1 WHERE id=?1 AND state='held' AND posting=0 AND (next_attempt_at IS NULL OR next_attempt_at<=?2)", rusqlite::params![id, now]).map_err(AppStorageError::sqlite)?;
            if changed == 0 { return Ok(None); }
            let attempts = db.query_row("SELECT attempts FROM app_initiated_messages WHERE id=?1", [&id], |r| r.get(0)).map_err(AppStorageError::sqlite)?;
            Ok(Some(Self { storage: owner, clock, id, runtime, attempts, queue }))
        }).await
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let storage = self.storage.clone();
        let id = self.id.clone();
        let attempts = self.attempts;
        let queue = self.queue.clone();
        let now = self.clock.now_iso();
        self.runtime.spawn(async move {
            let result = storage
                .execute(move |db| {
                    let next = super::retry::retry_at(&now, attempts)?;
                    let changed = db.execute(
                        "UPDATE app_initiated_messages SET posting=0,next_attempt_at=?3 WHERE id=?1 AND posting=1 AND state='held' AND attempts=?2",
                        rusqlite::params![id, attempts, next],
                    )
                    .map_err(AppStorageError::sqlite)?;
                    Ok(changed)
                })
                .await;
            match result {
                Ok(0) => {},
                Ok(_) => {
                    if let Err(error) = queue.wake(None).await { tracing::error!(%error, "wake queue after releasing work result failed"); }
                },
                Err(error) => tracing::error!(%error, "release work result reservation failed"),
            }
        });
    }
}
