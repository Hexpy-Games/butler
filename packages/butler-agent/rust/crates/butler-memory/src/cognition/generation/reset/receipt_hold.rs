//! E2E fixture: another in-process writer holds the shared lease when a reset
//! stores its terminal receipt, until the harness releases it.
use super::{CognitionPathEnvironment, CognitionWriteCoordinator, acquire};
use std::{io, path::Path, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub(super) async fn hold(
    root: &Path,
    paths: &CognitionPathEnvironment,
    coordinator: &Arc<CognitionWriteCoordinator>,
    operation: &str,
) -> io::Result<()> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub") {
        return Ok(());
    }
    let state = root.join("state");
    let arm = state.join("reset-receipt-hold-arm");
    let armed = tokio::task::spawn_blocking({
        let (arm, operation) = (arm.clone(), operation.to_owned());
        move || match std::fs::read_to_string(&arm) {
            Ok(id) if id == operation => std::fs::remove_file(&arm).map(|()| true),
            Ok(_) => Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    })
    .await
    .map_err(io::Error::other)??;
    if !armed {
        return Ok(());
    }
    let lease = acquire(
        root,
        paths,
        coordinator,
        "e2e_receipt_holder",
        &CancellationToken::new(),
    )
    .await?;
    let operation = operation.to_owned();
    tokio::task::spawn_blocking(move || {
        std::fs::write(state.join("reset-receipt-hold-reached"), operation)?;
        // The lease is held when this returns; the reset's receipt write meets it.
        std::thread::spawn(move || {
            while !state.join("reset-receipt-hold-release").exists() {
                std::thread::park_timeout(Duration::from_millis(10));
            }
            let _ = lease.release(false);
        });
        Ok::<_, io::Error>(())
    })
    .await
    .map_err(io::Error::other)?
}
