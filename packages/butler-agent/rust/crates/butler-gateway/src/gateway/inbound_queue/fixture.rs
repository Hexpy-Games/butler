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

/// One real-queue publication failure, without failing the queue's consumer.
pub(super) fn before_publish(
    root: &Path,
    envelope: &butler_core::json::JsonDocument,
) -> QueueResult<()> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub") {
        return Ok(());
    }
    let marker = root.join("e2e-enqueue-fault.json");
    let fault = match std::fs::read(&marker) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(InboundQueueError::new(
                InboundQueueCode::InboundQueueIoFailed,
                error.to_string(),
            ));
        }
    };
    let fault: serde_json::Value = serde_json::from_slice(&fault).map_err(|error| {
        InboundQueueError::new(InboundQueueCode::InboundQueueIoFailed, error.to_string())
    })?;
    let input: serde_json::Value = envelope.read().map_err(|error| {
        InboundQueueError::new(InboundQueueCode::InboundQueueIoFailed, error.to_string())
    })?;
    if fault["role"].as_str().is_some() && input["nativeStewardContext"]["role"] == fault["role"] {
        std::fs::remove_file(marker).map_err(|error| {
            InboundQueueError::new(InboundQueueCode::InboundQueueIoFailed, error.to_string())
        })?;
        return Err(InboundQueueError::new(
            InboundQueueCode::InboundQueueIoFailed,
            "Injected enqueue failure",
        ));
    }
    Ok(())
}
