//! Release a delivery claim even when its request future is cancelled.
use super::super::{AppStorageError, storage::AppStorage};

pub(in crate::gateway::application) struct Reservation {
    storage: AppStorage,
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
        storage.execute(move |db| {
            let changed = db.execute("UPDATE app_initiated_messages SET posting=1 WHERE id=?1 AND state='held' AND posting=0", [&id]).map_err(AppStorageError::sqlite)?;
            if changed == 0 { return Ok(None); }
            let attempts = db.query_row("SELECT attempts FROM app_initiated_messages WHERE id=?1", [&id], |r| r.get(0)).map_err(AppStorageError::sqlite)?;
            Ok(Some(Self { storage: owner, id, runtime, attempts, queue }))
        }).await
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let storage = self.storage.clone();
        let id = self.id.clone();
        let attempts = self.attempts;
        let queue = self.queue.clone();
        self.runtime.spawn(async move {
            let result = storage
                .execute(move |db| {
                    let changed = db.execute(
                        "UPDATE app_initiated_messages SET posting=0 WHERE id=?1 AND posting=1 AND state='held' AND attempts=?2",
                        rusqlite::params![id, attempts],
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
