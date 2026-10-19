//! Explicit fixture inputs; compiled out of shipped builds.
pub(crate) fn portable_file_fixture() -> bool {
    std::env::var("BUTLER_E2E_PORTABLE_LANCE").as_deref() == Ok("1")
}

use std::{io, path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

pub(crate) async fn reset_settlement(root: &Path, token: &CancellationToken) -> io::Result<()> {
    if std::env::var("BUTLER_E2E_RESET_SETTLEMENT_GATE").as_deref() != Ok("1") {
        return Ok(());
    }
    let root = root.to_owned();
    let token = token.clone();
    tokio::task::spawn_blocking(move || {
        let arm = root.join("state/reset-settlement-arm");
        if !arm.try_exists()? {
            return Ok(());
        }
        butler_platform::secure_fs::replace_private(
            &root.join("state/reset-settlement-reached"),
            |file| {
                use std::io::Write;
                file.write_all(b"cutover committed; receipt pending")
            },
            |error| error,
        )?;
        while arm.try_exists()? {
            if token.is_cancelled() {
                return Err(io::Error::other("Cancelled reset settlement gate"));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    })
    .await
    .map_err(io::Error::other)?
}

// Deterministic contention on an accepted reset, restricted to E2E fixture builds.
pub(crate) fn hold_reset_acquisition<E>(
    root: &std::path::Path,
    operation: &str,
    token: &CancellationToken,
    io_error: fn(io::Error) -> E,
    cancelled: fn() -> E,
) -> Result<(), E> {
    let state = root.join("state");
    let arm = state.join("profile-reset-acquire-arm");
    match std::fs::read_to_string(&arm) {
        Ok(id) if id == operation => {}
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error(error)),
    }
    std::fs::remove_file(arm).map_err(io_error)?;
    std::fs::write(state.join("profile-reset-acquire-reached"), operation).map_err(io_error)?;
    while !state.join("profile-reset-acquire-release").exists() {
        if token.is_cancelled() {
            return Err(cancelled());
        }
        std::thread::park_timeout(std::time::Duration::from_millis(10));
    }
    Ok(())
}
