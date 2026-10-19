//! A foreground agent must also finish startup or release its reserved port.

use std::{future::Future, time::Duration};

use crate::host::runtime::startup_trace::Correction;
use butler_turn::btcc::BtccError;
use tokio::sync::{oneshot, watch};

use super::stop_signal::StopSignal;

/// Matches the CLI startup deadline; it never limits a running service.
pub(crate) const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

pub(super) async fn until_ready(
    service: impl Future<Output = Result<String, BtccError>>,
    ready: oneshot::Receiver<()>,
    timing: watch::Receiver<Correction>,
    stop: &StopSignal,
) -> Result<String, BtccError> {
    tokio::pin!(service);
    tokio::select! {
        // A failed startup drops readiness before asynchronous cleanup finishes.
        // Keep polling the service so its original error survives that teardown.
        biased;
        result = &mut service => result,
        initialized = wait_ready(ready, timing) => {
            if initialized {
                service.await
            } else {
                trace_timeout().await;
                Err(BtccError::relayed(
                    "native_service_start_timeout", "Startup exceeded its readiness deadline",
                ))
            }
        }
        () = stop.wait() => Err(StopSignal::cancelled_startup()),
    }
}

// Timing updates are change-driven; external CLI/Electron sidecars are unchanged.
async fn wait_ready(
    mut ready: oneshot::Receiver<()>,
    mut timing: watch::Receiver<Correction>,
) -> bool {
    let original = std::time::Instant::now() + STARTUP_TIMEOUT;
    loop {
        let deadline = match *timing.borrow_and_update() {
            Correction::Pending => original,
            Correction::Validating(start) | Correction::Running(start) => {
                start + Duration::from_secs(180) + STARTUP_TIMEOUT
            }
            Correction::Finished(end) => original.max(end + STARTUP_TIMEOUT),
        };
        tokio::select! {
            biased;
            _ = &mut ready => return true,
            changed = timing.changed() => {
                if changed.is_err() {
                    return true; // Preserve the service's original startup error.
                }
            }
            () = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => return false,
        }
    }
}

/// Sample only after startup has already failed its original deadline. This
/// adds no polling or resource work to successful startup or runtime idle.
async fn trace_timeout() {
    if std::env::var("BUTLER_STARTUP_TRACE").as_deref() != Ok("1") {
        return;
    }
    let resources = tokio::task::spawn_blocking(|| {
        butler_platform::process_control::sample_usage(std::process::id())
    })
    .await;
    butler_core::diagnostic!("[native-startup] phase=timeout_resources sample={resources:?}");
}
