//! A foreground agent must also finish startup or release its reserved port.

use std::{future::Future, time::Duration};

use butler_turn::btcc::BtccError;
use tokio::sync::oneshot;

use super::stop_signal::StopSignal;

/// Matches the CLI startup deadline; it never limits a running service.
pub(crate) const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

pub(super) async fn until_ready(
    service: impl Future<Output = Result<String, BtccError>>,
    ready: oneshot::Receiver<()>,
    stop: &StopSignal,
) -> Result<String, BtccError> {
    tokio::pin!(service);
    tokio::select! {
        // A failed startup drops readiness before asynchronous cleanup finishes.
        // Keep polling the service so its original error survives that teardown.
        biased;
        result = &mut service => result,
        initialized = tokio::time::timeout(STARTUP_TIMEOUT, ready) => {
            match initialized {
                Ok(_) => service.await,
                Err(_) => {
                    trace_timeout().await;
                    Err(BtccError::relayed(
                        "native_service_start_timeout", "Startup did not finish within 90 seconds",
                    ))
                },
            }
        }
        () = stop.wait() => Err(StopSignal::cancelled_startup()),
    }
}

/// Sample only after startup has already failed its original deadline. This
/// adds no polling or resource work to successful startup or runtime idle.
async fn trace_timeout() {
    if !matches!(
        std::env::var("BUTLER_E2E_TIER").as_deref(),
        Ok("stub" | "perf")
    ) || std::env::var("BUTLER_E2E_STARTUP_TRACE").as_deref() != Ok("1")
    {
        return;
    }
    let resources = tokio::task::spawn_blocking(|| {
        butler_platform::process_control::sample_usage(std::process::id())
    })
    .await;
    butler_core::diagnostic!("[native-startup] phase=timeout_resources sample={resources:?}");
}
