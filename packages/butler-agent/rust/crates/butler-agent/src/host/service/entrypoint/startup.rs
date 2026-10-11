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
        initialized = wait_ready(ready, stop) => {
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

// Only an expired startup timer probes the sidecar; no idle work is added.
async fn wait_ready(mut ready: oneshot::Receiver<()>, stop: &StopSignal) -> bool {
    if tokio::time::timeout(STARTUP_TIMEOUT, &mut ready)
        .await
        .is_ok()
    {
        return true;
    }
    let Some(path) = stop
        .data_root()
        .map(|root| root.join("agent-runtime/storage-correction.json"))
    else {
        return false;
    };
    let remaining = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut raw = String::new();
        std::fs::File::open(path)
            .ok()?
            .take(4097)
            .read_to_string(&mut raw)
            .ok()?;
        if raw.len() > 4096 {
            return None;
        }
        let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
        if value["schema"] != "butler.storage-correction-progress.v1"
            || !matches!(value["phase"].as_str(), Some("reclaim" | "compact"))
        {
            return None;
        }
        let deadline = chrono::DateTime::parse_from_rfc3339(value["deadlineAt"].as_str()?).ok()?;
        (deadline.with_timezone(&chrono::Utc) + chrono::Duration::seconds(30) - chrono::Utc::now())
            .to_std()
            .ok()
    })
    .await
    .ok()
    .flatten();
    match remaining {
        Some(remaining) => tokio::time::timeout(remaining, ready).await.is_ok(),
        None => false,
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
