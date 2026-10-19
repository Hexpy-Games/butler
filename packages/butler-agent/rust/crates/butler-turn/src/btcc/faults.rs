//! Explicit fixture inputs; compiled out of shipped builds.
use crate::btcc::{BtccCode, BtccError};
/// E2E fixture crash windows around the durable canonical insert transaction.
pub(crate) async fn hold_delivery(phase: &str, turn_id: &str) -> Result<(), BtccError> {
    if std::env::var("BUTLER_E2E_HOLD_DELIVERY").as_deref() != Ok(phase) {
        return Ok(());
    }
    let Some(data) = std::env::var_os("BUTLER_DATA") else {
        return Ok(());
    };
    let data = std::path::PathBuf::from(data);
    let io_error = |error: std::io::Error| {
        BtccError::detected(BtccCode::BtccTaskFailed, "stub delivery barrier failed")
            .with_source(error)
    };
    tokio::fs::write(data.join("e2e-delivery-held"), turn_id)
        .await
        .map_err(io_error)?;
    while !tokio::fs::try_exists(data.join("e2e-delivery-release"))
        .await
        .map_err(io_error)?
    {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    Ok(())
}

pub(crate) fn storage_baseline() -> bool {
    std::env::var_os("BUTLER_E2E_STORAGE_BASELINE").is_some()
}
