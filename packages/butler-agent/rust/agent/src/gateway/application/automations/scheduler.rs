use std::{sync::Mutex, time::Duration};

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::super::{AppApplication, GatewayApplicationError};

const SCHEDULER_INTERVAL: Duration = Duration::from_secs(30);

pub(crate) struct AutomationScheduler {
    cancellation: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl AutomationScheduler {
    pub(crate) fn start() -> Self {
        Self {
            cancellation: CancellationToken::new(),
            task: Mutex::new(None),
        }
    }

    pub(crate) async fn initialize(
        &self,
        app: AppApplication,
    ) -> Result<(), GatewayApplicationError> {
        let cancel = self.cancellation.clone();
        let task = tokio::spawn(async move {
            let mut timer = tokio::time::interval(SCHEDULER_INTERVAL);
            timer.tick().await;
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = timer.tick() => {
                        if app.dispatch_due_owned().await.is_err() {
                            app.record_automation_scheduler_error("automation_scheduler_failed").await;
                        }
                    }
                }
            }
        });
        *self.task.lock().unwrap_or_else(|error| error.into_inner()) = Some(task);
        Ok(())
    }

    pub(crate) async fn close(&self) -> Result<(), GatewayApplicationError> {
        self.cancellation.cancel();
        let task = self
            .task
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(task) = task {
            task.await.map_err(|_| GatewayApplicationError::Internal)?;
        }
        Ok(())
    }
}
