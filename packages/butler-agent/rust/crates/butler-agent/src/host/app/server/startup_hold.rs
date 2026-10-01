//! Stub-only startup barrier: tests release it after probing the reserved port.

use butler_turn::btcc::BtccError;

pub(super) async fn wait(data_root: &std::path::Path) -> Result<(), BtccError> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub")
        || std::env::var("BUTLER_E2E_HOLD_APP_STARTUP").as_deref() != Ok("1")
    {
        return Ok(());
    }
    let held = data_root.join("e2e-startup-held");
    let release = data_root.join("e2e-startup-release");
    tokio::fs::write(held, b"held")
        .await
        .map_err(|error| BtccError::relayed("e2e_startup_hold_failed", error.to_string()))?;
    while !tokio::fs::try_exists(&release)
        .await
        .map_err(|error| BtccError::relayed("e2e_startup_hold_failed", error.to_string()))?
    {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    Ok(())
}
