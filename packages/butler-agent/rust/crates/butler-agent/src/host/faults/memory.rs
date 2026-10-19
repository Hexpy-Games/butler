use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;
/// E2E race gate: the durable completion queue must suffice when filesystem
/// notifications are coalesced, so a fixture build can drop the canonical wake.
pub(in crate::host) fn canonical_wake_held() -> bool {
    std::env::var("BUTLER_E2E_HOLD_CANONICAL_WAKE").as_deref() == Ok("1")
}

/// E2E fixture barrier before the fresh memory bootstrap; ends on shutdown.
pub(in crate::host) async fn hold_bootstrap(data_root: &Path, shutdown: &CancellationToken) {
    if std::env::var("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP").as_deref() != Ok("1") {
        return;
    }
    while !tokio::fs::try_exists(data_root.join("state/e2e-memory-bootstrap-release"))
        .await
        .unwrap_or(false)
    {
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = tokio::time::sleep(Duration::from_millis(20)) => {},
        }
    }
}

pub(in crate::host) fn epoch_millis() -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(&super::clock()?.now_iso())
        .ok()
        .map(|now| now.timestamp_millis())
}
