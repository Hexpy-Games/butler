//! Stub-only synchronization of the post-cutover receipt for the real-route race E2E.
use std::{io, path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

pub(super) async fn test_gate(root: &Path, token: &CancellationToken) -> io::Result<()> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub")
        || std::env::var("BUTLER_E2E_RESET_SETTLEMENT_GATE").as_deref() != Ok("1")
    {
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
