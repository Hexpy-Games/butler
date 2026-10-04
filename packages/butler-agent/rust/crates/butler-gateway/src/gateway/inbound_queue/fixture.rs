//! Stub-only barrier between final transcript append and durable settlement.
use super::{InboundQueueCode, InboundQueueError, QueueResult};
use std::{path::Path, time::Duration};

pub(super) async fn before_settlement(root: &Path) -> QueueResult<()> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub")
        || std::env::var("BUTLER_E2E_HOLD_SETTLEMENT").as_deref() != Ok("1")
    {
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
