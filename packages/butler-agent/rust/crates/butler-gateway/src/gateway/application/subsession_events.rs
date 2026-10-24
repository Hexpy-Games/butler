//! Change-driven invalidation of canonical delegated execution views.

use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use super::{AppApplication, events, service};

pub(super) fn start(application: &AppApplication) {
    super::canon_sidebar::start(application);
    super::task_graphs::start_events(application);
    super::canon::start(application);
    let Some(mut changes) = application.dependencies.subsessions.changes() else {
        return;
    };
    let storage = application.storage.clone();
    let subscribers = application.subscribers.clone();
    let queue_wake = application.queue_wake.clone();
    let clock = application.dependencies.identity_clock.clone();
    let shutdown = application.dependencies.service_shutdown.clone();
    tokio::spawn(async move {
        loop {
            let change = tokio::select! {
                () = shutdown.cancelled() => return,
                change = changes.recv() => change,
            };
            let lagged = matches!(&change, Err(RecvError::Lagged(_)));
            let parent = change.as_ref().ok().map(|(parent, _)| parent.clone());
            let (kind, payload) = match change {
                Ok((parent, child)) => (
                    "subsession.changed",
                    json!({
                        "session_id": parent, "child_session_id": child,
                    }),
                ),
                Err(RecvError::Lagged(_)) => ("stream.reconcile_required", json!({})),
                Err(RecvError::Closed) => return,
            };
            let chat = match parent {
                Some(parent) => storage
                    .read(move |db| super::sessions::identity::resolve_owner(db, &parent))
                    .await
                    .unwrap_or(None),
                None => None,
            };
            if (chat.is_some() || lagged)
                && let Err(error) = queue_wake.wake(chat).await
            {
                butler_core::diagnostic!("[gateway] subsession queue wake failed: {error}");
            }
            let subscribers = subscribers.clone();
            let now = clock.now_iso();
            if let Err(error) = storage
                .execute(move |db| {
                    events::append(db, &subscribers, kind, None, service::map(&payload)?, &now)
                })
                .await
            {
                butler_core::diagnostic!(
                    "[gateway] subsession event unavailable: {}",
                    error.code()
                );
            }
        }
    });
}
