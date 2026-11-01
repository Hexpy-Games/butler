//! Stub-only barriers at the Ledger/BTCC boundaries of a Work.
use crate::btcc::BtccError;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) async fn after_plan() -> Result<(), BtccError> {
    barrier("BUTLER_E2E_HANDOFF_PLAN_BARRIER", b"planned").await
}

/// Around the start of the Work a direction runs on.
pub(super) async fn direction_work(stage: &'static [u8]) -> Result<(), BtccError> {
    barrier("BUTLER_E2E_DIRECTION_WORK_BARRIER", stage).await
}

#[allow(clippy::disallowed_methods, reason = "stub-only loopback barrier")]
async fn barrier(variable: &str, stage: &[u8]) -> Result<(), BtccError> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub") {
        return Ok(());
    }
    let Ok(address) = std::env::var(variable) else {
        return Ok(());
    };
    let fail = |error: String| BtccError::relayed("handoff_barrier_failed", error);
    let address: std::net::SocketAddr = address
        .parse()
        .map_err(|e: std::net::AddrParseError| fail(e.to_string()))?;
    if !address.ip().is_loopback() {
        return Err(fail("Barrier requires loopback".into()));
    }
    let mut socket = tokio::net::TcpStream::connect(address)
        .await
        .map_err(|e| fail(e.to_string()))?;
    socket
        .write_all(stage)
        .await
        .map_err(|e| fail(e.to_string()))?;
    socket.read_u8().await.map_err(|e| fail(e.to_string()))?;
    Ok(())
}
