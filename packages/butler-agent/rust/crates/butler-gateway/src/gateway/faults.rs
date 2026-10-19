//! Explicit fixture inputs; compiled out of shipped builds.
pub(crate) fn observe_filesystem() -> bool {
    !(std::env::var("BUTLER_E2E_DISABLE_PROJECTION_WATCH").as_deref() == Ok("1"))
}
pub(crate) fn baseline() -> bool {
    std::env::var_os("BUTLER_E2E_STORAGE_BASELINE").is_some()
}
pub(crate) fn storage_metrics() -> bool {
    std::env::var_os("BUTLER_E2E_STORAGE_METRICS").is_some()
}
pub(crate) fn idle_probe() -> bool {
    std::env::var("BUTLER_E2E_IDLE_PROBE").as_deref() == Ok("1")
}

use crate::gateway::{InboundQueueCode, InboundQueueError};
use std::{path::Path, time::Duration};

pub(crate) async fn before_settlement(root: &Path) -> Result<(), InboundQueueError> {
    if std::env::var("BUTLER_E2E_HOLD_SETTLEMENT").as_deref() != Ok("1") {
        return Ok(());
    }
    let marker = root.join("e2e-settlement-waiting");
    tokio::fs::write(&marker, b"waiting")
        .await
        .map_err(|error| {
            InboundQueueError::new(InboundQueueCode::InboundQueueIoFailed, error.to_string())
        })?;
    let release = root.join("e2e-settlement-release");
    while !tokio::fs::try_exists(&release).await.map_err(|error| {
        InboundQueueError::new(InboundQueueCode::InboundQueueIoFailed, error.to_string())
    })? {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}

pub(crate) async fn queue_admission(root: &Path, message_id: &str) -> std::io::Result<bool> {
    if std::env::var("BUTLER_E2E_HOLD_QUEUE_MESSAGE").as_deref() != Ok(message_id) {
        return Ok(false);
    }
    tokio::fs::write(root.join("e2e-queue-admission-held"), b"held").await?;
    Ok(true)
}

pub(crate) fn latency_trace() -> bool {
    std::env::var("BUTLER_E2E_STORAGE_METRICS").as_deref() == Ok("1")
}
