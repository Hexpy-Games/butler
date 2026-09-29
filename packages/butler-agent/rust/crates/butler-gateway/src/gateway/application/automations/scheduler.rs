use std::{sync::Arc, time::Duration};

use chrono::DateTime;
use parking_lot::Mutex;
use tokio::{sync::Notify, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use super::super::{AppApplication, GatewayApplicationError};

pub(crate) fn signals() -> (Arc<Notify>, Arc<std::sync::atomic::AtomicBool>) {
    (
        Arc::new(Notify::new()),
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
    )
}

pub(crate) struct AutomationScheduler {
    cancellation: CancellationToken,
    wake: Arc<Notify>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl AutomationScheduler {
    pub(crate) fn start(wake: Arc<Notify>) -> Self {
        Self {
            cancellation: CancellationToken::new(),
            wake,
            task: Mutex::new(None),
        }
    }

    pub(crate) fn initialize(&self, app: AppApplication) -> Result<(), GatewayApplicationError> {
        let cancel = self.cancellation.clone();
        let wake = self.wake.clone();
        *self.task.lock() = Some(tokio::spawn(async move {
            // Recovery also dispatches runs queued before a restart.
            let _ = dispatch(&app).await;
            loop {
                let next = match app.next_automation_due().await {
                    Ok(next) => next,
                    Err(_) => {
                        app.record_automation_scheduler_error("automation_scheduler_failed")
                            .await;
                        None
                    }
                };
                let notified = wake.notified();
                match next {
                    Some(next) => {
                        let delay = due_delay(&app, &next);
                        tokio::select! {
                            () = cancel.cancelled() => break,
                            () = notified => { let _ = dispatch(&app).await; },
                            () = tokio::time::sleep(delay) => {
                                if !dispatch(&app).await {
                                    tokio::select! {
                                        () = cancel.cancelled() => break,
                                        () = wake.notified() => {},
                                    }
                                }
                            },
                        }
                    }
                    None => tokio::select! {
                        () = cancel.cancelled() => break,
                        () = notified => { let _ = dispatch(&app).await; },
                    },
                }
            }
        }));
        Ok(())
    }

    pub(crate) async fn close(&self) -> Result<(), GatewayApplicationError> {
        self.cancellation.cancel();
        let task = self.task.lock().take();
        if let Some(task) = task {
            task.await.map_err(GatewayApplicationError::internal_from)?;
        }
        Ok(())
    }
}

async fn dispatch(app: &AppApplication) -> bool {
    if app.dispatch_due_owned().await.is_err() {
        app.record_automation_scheduler_error("automation_scheduler_failed")
            .await;
        return false;
    }
    true
}

fn due_delay(app: &AppApplication, next: &str) -> Duration {
    let now = app.dependencies.identity_clock.now_iso();
    let Ok(next) = DateTime::parse_from_rfc3339(next) else {
        return Duration::ZERO;
    };
    let Ok(now) = DateTime::parse_from_rfc3339(&now) else {
        return Duration::ZERO;
    };
    Duration::from_millis(u64::try_from((next - now).num_milliseconds()).unwrap_or_default())
}
