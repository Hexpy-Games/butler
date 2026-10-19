//! Fixture-only rendezvous after a real writer wait expires. The acknowledgement
//! lets a harness release an external lock before failure settlement starts.
use super::{CognitionWriteAcquire, CoordinationError, CoordinationResult};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) async fn expired(request: &CognitionWriteAcquire) -> CoordinationResult<()> {
    let Ok(address) = std::env::var("BUTLER_E2E_WRITE_WAIT_OBSERVER") else {
        return Ok(());
    };
    let address: std::net::SocketAddr = address.parse().map_err(CoordinationError::gate_io)?;
    if !address.ip().is_loopback() {
        return Err(CoordinationError::gate_io(std::io::Error::other(
            "wait observer must be loopback",
        )));
    }
    #[expect(
        clippy::disallowed_methods,
        reason = "fixture-only non-HTTP loopback control channel"
    )]
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .map_err(CoordinationError::gate_io)?;
    stream
        .write_all(format!("{}\n", request.purpose.as_deref().unwrap_or_default()).as_bytes())
        .await
        .map_err(CoordinationError::gate_io)?;
    let mut ack = [0];
    stream
        .read_exact(&mut ack)
        .await
        .map_err(CoordinationError::gate_io)?;
    Ok(())
}
