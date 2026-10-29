//! Stub-only barrier at the Ledger/BTCC handoff boundary.
use crate::btcc::BtccError;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[allow(clippy::disallowed_methods, reason = "stub-only loopback barrier")]
pub(super) async fn after_plan() -> Result<(), BtccError> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub") {
        return Ok(());
    }
    let Ok(address) = std::env::var("BUTLER_E2E_HANDOFF_PLAN_BARRIER") else {
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
        .write_all(b"planned")
        .await
        .map_err(|e| fail(e.to_string()))?;
    socket.read_u8().await.map_err(|e| fail(e.to_string()))?;
    Ok(())
}
