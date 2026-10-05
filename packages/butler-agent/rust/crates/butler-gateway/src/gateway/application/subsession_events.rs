//! Change-driven invalidation of canonical delegated execution views.

use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use super::{AppApplication, events, service};

pub(super) fn start(application: &AppApplication) {
    let Some(mut changes) = application.dependencies.subsessions.changes() else {
        return;
    };
    let storage = application.storage.clone();
    let subscribers = application.subscribers.clone();
    let clock = application.dependencies.identity_clock.clone();
    let shutdown = application.dependencies.service_shutdown.clone();
    tokio::spawn(async move {
        loop {
            let change = tokio::select! {
                () = shutdown.cancelled() => return,
                change = changes.recv() => change,
            };
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
