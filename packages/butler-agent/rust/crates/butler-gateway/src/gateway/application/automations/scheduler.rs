#[cfg(feature = "e2e-fixtures")]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{sync::Arc, time::Duration};

use chrono::DateTime;
use parking_lot::Mutex;
use tokio::{sync::Notify, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use super::super::{AppApplication, GatewayApplicationError};

#[cfg(feature = "e2e-fixtures")]
static NEXT_DUE_READS: AtomicUsize = AtomicUsize::new(0);

#[cfg(feature = "e2e-fixtures")]
pub(crate) fn next_due_read_count() -> usize {
    NEXT_DUE_READS.load(Ordering::Relaxed)
}

#[cfg(feature = "e2e-fixtures")]
static DISPATCH_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);

#[cfg(feature = "e2e-fixtures")]
pub(crate) fn dispatch_attempt_count() -> usize {
    DISPATCH_ATTEMPTS.load(Ordering::Relaxed)
}

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
    wake_task: Mutex<Option<JoinHandle<()>>>,
}

impl AutomationScheduler {
    pub(crate) fn start(wake: Arc<Notify>) -> Self {
        Self {
            cancellation: CancellationToken::new(),
            wake,
            task: Mutex::new(None),
            wake_task: Mutex::new(None),
        }
    }

    pub(crate) fn initialize(&self, app: AppApplication) -> Result<(), GatewayApplicationError> {
        reset_counters();
        self.subscribe_to_wake();
        let cancel = self.cancellation.clone();
        let wake = self.wake.clone();
        *self.task.lock() = Some(tokio::spawn(async move {
            let mut dispatch_failing = false;
            let mut read_failing = false;
            // Due runs admit turns, which first needs the executor, as for
            // the queue dispatcher; a failed wait leaves dispatch to report.
            tokio::select! {
                biased;
                () = cancel.cancelled() => return,
                _ = app.dependencies.executor_readiness.wait_ready() => {},
            }
            let proposals = app.dependencies.memory_management.proposals_changed();
            let _ = app.collect_proposals().await;
            // Recovery also dispatches runs queued before a restart.
            let _ = dispatch(&app, &mut dispatch_failing).await;
            loop {
                #[cfg(feature = "e2e-fixtures")]
                NEXT_DUE_READS.fetch_add(1, Ordering::Relaxed);
                let lookup = next_due(&app).await;
                let read_failed = lookup.is_err();
                let next = match lookup {
                    Ok(next) => {
                        read_failing = false;
                        next
                    }
                    Err(_) => {
                        record_failure(&app, &mut read_failing).await;
                        None
                    }
                };
                let notified = wake.notified();
                tokio::pin!(notified);
                match next {
                    Some(next) => loop {
                        let delay =
                            due_delay(&app, &next).min(butler_core::wall_clock::MAX_WAIT_SLICE);
                        tokio::select! {
                            () = cancel.cancelled() => return,
                            () = proposal_signal(proposals.as_ref()) => {
                                let _ = app.collect_proposals().await;
                                let _ = dispatch(&app, &mut dispatch_failing).await;
                                break;
                            },
                            () = &mut notified => {
                                let _ = dispatch(&app, &mut dispatch_failing).await;
                                break;
                            },
                            () = tokio::time::sleep(delay) => {
                                // Clock slices retain the indexed lookup and notification.
                                if !due_delay(&app, &next).is_zero() {
                                    continue;
                                }
                                if !dispatch(&app, &mut dispatch_failing).await {
                                    tokio::select! {
                                        () = cancel.cancelled() => return,
                                        () = &mut notified => {},
                                        () = tokio::time::sleep(butler_core::wall_clock::MAX_WAIT_SLICE) => {},
                                    }
                                }
                                break;
                            },
                        }
                    },
                    // An empty store stays notify-only; failed lookups retry.
                    None => tokio::select! {
                        () = cancel.cancelled() => break,
                        () = proposal_signal(proposals.as_ref()) => { let _ = app.collect_proposals().await; let _ = dispatch(&app, &mut dispatch_failing).await; },
                        () = &mut notified => { let _ = dispatch(&app, &mut dispatch_failing).await; },
                        () = tokio::time::sleep(butler_core::wall_clock::MAX_WAIT_SLICE), if read_failed => {},
                    },
                }
            }
        }));
        Ok(())
    }

    fn subscribe_to_wake(&self) {
        let mut events = butler_platform::system_wake::wake_events();
        let wake = self.wake.clone();
        let cancel = self.cancellation.clone();
        *self.wake_task.lock() = Some(tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = cancel.cancelled() => break,
                    event = events.changed() => {
                        if event.is_err() { break; }
                        wake.notify_one();
                    }
                }
            }
        }));
    }

    pub(crate) async fn close(&self) -> Result<(), GatewayApplicationError> {
        self.cancellation.cancel();
        let wake_task = self.wake_task.lock().take();
        if let Some(task) = wake_task {
            task.await.map_err(GatewayApplicationError::internal_from)?;
        }
        let task = self.task.lock().take();
        if let Some(task) = task {
            task.await.map_err(GatewayApplicationError::internal_from)?;
        }
        Ok(())
    }
}

async fn dispatch(app: &AppApplication, failing: &mut bool) -> bool {
    #[cfg(feature = "e2e-fixtures")]
    let timing = crate::gateway::command_timing::CommandTiming::new("scheduler_dispatch");
    let succeeded = app.dispatch_due_owned().await.is_ok();
    #[cfg(feature = "e2e-fixtures")]
    timing.mark("owned_completed");
    if succeeded {
        *failing = false;
    } else {
        record_failure(app, failing).await;
    }
    #[cfg(feature = "e2e-fixtures")]
    {
        timing.mark("completed");
        drop(timing);
        DISPATCH_ATTEMPTS.fetch_add(1, Ordering::Relaxed);
    }
    succeeded
}

async fn record_failure(app: &AppApplication, failing: &mut bool) {
    if !*failing {
        *failing = app
            .record_automation_scheduler_error("automation_scheduler_failed")
            .await;
    }
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

async fn next_due(app: &AppApplication) -> Result<Option<String>, GatewayApplicationError> {
    let schedule = app.next_automation_due().await?;
    let initiated = app.next_initiated_due().await?;
    Ok(match (schedule, initiated) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    })
}
async fn proposal_signal(signal: Option<&Arc<Notify>>) {
    match signal {
        Some(signal) => signal.notified().await,
        None => std::future::pending().await,
    }
}

fn reset_counters() {
    #[cfg(feature = "e2e-fixtures")]
    {
        NEXT_DUE_READS.store(0, Ordering::Relaxed);
        DISPATCH_ATTEMPTS.store(0, Ordering::Relaxed);
    }
}
