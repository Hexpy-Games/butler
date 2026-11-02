//! Stub-only rendezvous at the start of a query drain, so a scenario can place
//! a second request at a known point inside the grace instead of racing it.

/// Holds the drain until the harness answers. Returns whether it did, in which
/// case the real grace starts now, not at the original request's deadline.
/// Outside the stub tier, or without a loopback address in
/// `BUTLER_E2E_DRAIN_BARRIER`, this returns `false` at once.
#[cfg(feature = "e2e-fixtures")]
#[allow(clippy::disallowed_methods, reason = "stub-only loopback barrier")]
pub(super) async fn reached() -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub") {
        return false;
    }
    let Some(address) = std::env::var("BUTLER_E2E_DRAIN_BARRIER")
        .ok()
        .and_then(|value| value.parse::<std::net::SocketAddr>().ok())
        .filter(|address| address.ip().is_loopback())
    else {
        return false;
    };
    let Ok(mut socket) = tokio::net::TcpStream::connect(address).await else {
        return false;
    };
    socket.write_all(b"drain").await.is_ok() && socket.read_u8().await.is_ok()
}

/// Without `e2e-fixtures` there is no barrier.
#[cfg(not(feature = "e2e-fixtures"))]
pub(super) fn reached() -> std::future::Ready<bool> {
    std::future::ready(false)
}
