//! Forwards changed provider quota as durable `provider_quota_updated`
//! events. Readings come from provider responses or action-driven refreshes.

use parking_lot::Mutex;
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use butler_runtime::operations::ProviderQuotaUpdate;

use super::{AppApplication, events};

/// The live event type carrying `{provider_id, remaining}`.
pub(super) const PROVIDER_QUOTA_UPDATED: &str = "provider_quota_updated";

/// Owns the background task that turns quota changes into App events.
#[derive(Default)]
pub(super) struct QuotaEventForwarder {
    cancel: CancellationToken,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl QuotaEventForwarder {
    /// Starts forwarding once, when the monitoring port reports quota updates.
    pub(super) fn start(&self, application: AppApplication) {
        let mut tasks = self.tasks.lock();
        if !tasks.is_empty() {
            return;
        }
        if let Some(updates) = application.dependencies.monitoring.provider_quota_updates() {
            tasks.push(tokio::spawn(forward(
                application,
                updates,
                self.cancel.clone(),
            )));
        }
    }

    /// Stops forwarding and waits for it to end.
    pub(super) async fn close(&self) {
        self.cancel.cancel();
        let tasks = std::mem::take(&mut *self.tasks.lock());
        for task in tasks {
            let _ = task.await;
        }
    }
}

async fn forward(
    application: AppApplication,
    mut updates: broadcast::Receiver<ProviderQuotaUpdate>,
    cancel: CancellationToken,
) {
    loop {
        let update = tokio::select! {
            () = cancel.cancelled() => return,
            update = updates.recv() => update,
        };
        match update {
            Ok(update) => publish(&application, &update).await,
            Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => return,
        }
    }
}

async fn publish(application: &AppApplication, update: &ProviderQuotaUpdate) {
    let Some(payload) = serde_json::to_value(update)
        .ok()
        .and_then(|value| value.as_object().cloned())
    else {
        return;
    };
    let created_at = application.dependencies.identity_clock.now_iso();
    let subscribers = application.subscribers.clone();
    // A failed append drops this update only; the next change is published anew.
    let _ = application
        .storage
        .execute(move |db| {
            events::append(
                db,
                &subscribers,
                PROVIDER_QUOTA_UPDATED,
                None,
                payload,
                &created_at,
            )
        })
        .await;
}
