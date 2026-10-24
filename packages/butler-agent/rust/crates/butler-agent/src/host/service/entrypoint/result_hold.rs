//! Stub-only socket barrier after result admission, before outbox settlement.
use butler_turn::btcc::BtccError;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[allow(
    clippy::disallowed_methods,
    reason = "stub-only non-HTTP loopback control"
)]
pub(super) async fn before_delivered() -> Result<(), BtccError> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub") {
        return Ok(());
    }
    let Ok(address) = std::env::var("BUTLER_E2E_RESULT_DELIVERED_BARRIER") else {
        return Ok(());
    };
    let address: std::net::SocketAddr = address.parse().map_err(super::support::io)?;
    if !address.ip().is_loopback() {
        return Err(super::support::failure(
            "e2e_result_barrier_invalid",
            "The result barrier must use loopback",
        ));
    }
    let mut socket = tokio::net::TcpStream::connect(address)
        .await
        .map_err(super::support::io)?;
    socket
        .write_all(b"admitted")
        .await
        .map_err(super::support::io)?;
    socket.read_u8().await.map_err(super::support::io)?;
    Ok(())
}
