//! Stub-only acknowledgement of a real dispatcher decision to hold user input.
use super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};
use tokio::io::AsyncWriteExt;

#[allow(
    clippy::disallowed_methods,
    reason = "stub-only non-HTTP loopback control"
)]
pub(super) async fn observed(
    app: &AppApplication,
    chat: &str,
) -> Result<(), GatewayApplicationError> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub") {
        return Ok(());
    }
    let Ok(address) = std::env::var("BUTLER_E2E_QUEUE_WAIT_OBSERVER") else {
        return Ok(());
    };
    let address: std::net::SocketAddr = address
        .parse()
        .map_err(GatewayApplicationError::internal_from)?;
    if !address.ip().is_loopback() {
        return Err(GatewayApplicationError::internal());
    }
    let chat = chat.to_owned();
    let turn: String = app
        .storage
        .read(move |db| {
            db.query_row(
                "SELECT id FROM turns WHERE chat_id=?1 ORDER BY rowid DESC LIMIT 1",
                [chat],
                |r| r.get(0),
            )
            .map_err(AppStorageError::sqlite)
        })
        .await
        .map_err(app_error)?;
    let mut socket = tokio::net::TcpStream::connect(address)
        .await
        .map_err(GatewayApplicationError::internal_from)?;
    socket
        .write_all(turn.as_bytes())
        .await
        .map_err(GatewayApplicationError::internal_from)
}
