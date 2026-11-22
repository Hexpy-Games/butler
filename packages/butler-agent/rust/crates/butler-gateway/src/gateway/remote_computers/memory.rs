//! The main's side of a computer's memory: a read-only copy of its
//! instructions and profile, handed over on every connect.
use super::{AppSetupPort, Computer, HttpError, relay, remote_error};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) async fn push_copy(
    setup: &Arc<dyn AppSetupPort>,
    computer: &Computer,
    cancel: CancellationToken,
) -> Result<(), HttpError> {
    let copy = setup.computer_memory_copy().await?;
    let reply = relay::request(
        computer,
        "POST",
        "/remote/memory",
        copy.to_string().into_bytes(),
        cancel,
    )
    .await?;
    if reply.status == 204 {
        return Ok(());
    }
    Err(remote_error(
        "remote_memory_copy_failed",
        "Could not hand this computer its memory copy.",
    ))
}
