//! Watch-driven account events; only the public status is persisted.
use super::{AppIdentityClock, AppSetupPort, AppStorage, EventSubscribers, events};
use parking_lot::Mutex;
use std::sync::Arc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct AccountRelay {
    running: Mutex<Option<(CancellationToken, JoinHandle<()>)>>,
}
impl AccountRelay {
    pub(super) fn start(
        &self,
        setup: Arc<dyn AppSetupPort>,
        storage: AppStorage,
        subscribers: EventSubscribers,
        clock: Arc<dyn AppIdentityClock>,
    ) {
        let mut revision = setup.chatgpt_revision();
        revision.borrow_and_update();
        let stop = CancellationToken::new();
        let stopped = stop.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = revision.changed() => if changed.is_err() { break; },
                    () = stopped.cancelled() => break,
                }
                revision.borrow_and_update();
                let Ok(account) = setup.chatgpt_account().await else {
                    continue;
                };
                let serde_json::Value::Object(payload) =
                    serde_json::json!({"status":account.status})
                else {
                    continue;
                };
                let subscribers = subscribers.clone();
                let now = clock.now_iso();
                let _ = storage
                    .execute(move |db| {
                        events::append(
                            db,
                            &subscribers,
                            "setup.chatgpt_account_changed",
                            None,
                            payload,
                            &now,
                        )
                        .map(|_| ())
                    })
                    .await;
            }
        });
        if let Some((previous, _)) = self.running.lock().replace((stop, task)) {
            previous.cancel();
        }
    }
    pub(super) async fn close(&self) {
        let running = self.running.lock().take();
        if let Some((stop, task)) = running {
            stop.cancel();
            let _ = task.await;
        }
    }
}

/// Start both watch-driven setup projections at the dispatch boundary.
pub(super) fn start(application: &super::AppApplication) {
    application.setup_readiness.start(
        application.dependencies.setup.readiness(),
        application.storage.clone(),
        application.subscribers.clone(),
        application.dependencies.identity_clock.clone(),
    );
    application.chatgpt_events.start(
        application.dependencies.setup.clone(),
        application.storage.clone(),
        application.subscribers.clone(),
        application.dependencies.identity_clock.clone(),
    );
}
