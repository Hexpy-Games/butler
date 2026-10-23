//! Stub-only socket barrier after result admission, before outbox settlement.
use butler_turn::btcc::BtccError;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) async fn before_delivered() -> Result<(), BtccError> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub") {
        return Ok(());
    }
    let Ok(address) = std::env::var("BUTLER_E2E_RESULT_DELIVERED_BARRIER") else {
        return Ok(());
    };
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
