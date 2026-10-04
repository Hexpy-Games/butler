//! Forwards changed provider quota as durable `provider_quota_updated`
//! events, and runs the periodic quota poll while an App client is
//! connected (a live event stream is open).

use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

use butler_runtime::operations::ProviderQuotaUpdate;

use super::{AppApplication, events};

/// The live event type carrying `{provider_id, remaining}`.
pub(super) const PROVIDER_QUOTA_UPDATED: &str = "provider_quota_updated";

/// How often the poll loop asks the monitoring port to poll; the port
/// decides which providers are due (every 5 minutes after a success).
const POLL_TICK: Duration = Duration::from_secs(30);

/// Owns the background tasks that turn quota updates into App events and
/// poll quota while an App client is connected.
#[derive(Default)]
pub(super) struct QuotaEventForwarder {
    cancel: CancellationToken,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl QuotaEventForwarder {
    /// Starts forwarding (when the monitoring port reports quota updates)
    /// and the poll loop, once.
    pub(super) fn start(&self, application: AppApplication) {
        let mut tasks = self.tasks.lock();
        if !tasks.is_empty() {
            return;
        }
        if let Some(updates) = application.dependencies.monitoring.provider_quota_updates() {
            tasks.push(tokio::spawn(forward(
                application.clone_handle(),
                updates,
                self.cancel.clone(),
            )));
        }
        tasks.push(tokio::spawn(poll_while_connected(
            application,
            self.cancel.clone(),
        )));
    }

    /// Stops both tasks and waits for them to end.
    pub(super) async fn close(&self) {
        self.cancel.cancel();
        let tasks = std::mem::take(&mut *self.tasks.lock());
        for task in tasks {
            let _ = task.await;
        }
    }
}

/// Polls quota every tick while a live event stream is open.
async fn poll_while_connected(application: AppApplication, cancel: CancellationToken) {
    loop {
        while application.subscribers.listener_count() == 0 {
            tokio::select! {
                () = cancel.cancelled() => return,
                () = application.subscribers.listeners_changed() => {},
            }
        }
        // Connecting a listener must not add a zero-time poll before response headers.
        let mut ticks =
            tokio::time::interval_at(tokio::time::Instant::now() + POLL_TICK, POLL_TICK);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        while application.subscribers.listener_count() != 0 {
            tokio::select! {
                () = cancel.cancelled() => return,
                () = application.subscribers.listeners_changed() => continue,
                _ = ticks.tick() => {}
            }
            if application.subscribers.listener_count() == 0 {
                continue;
            }
            let poll = application.dependencies.monitoring.poll_provider_quota();
            tokio::select! {
                () = cancel.cancelled() => return,
                // A failed poll is recorded by the port; the loop keeps going.
                _ = poll => {}
            }
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
