//! A failed scan stops serving only when SQLite or consistency checks prove corruption.
use butler_turn::btcc::{
    BtccError, storage_error_is_corruption, storage_scan_delay, validate_storage_background,
};
use std::{future::Future, path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

pub(super) async fn while_serving<T>(
    data: &Path,
    serving: impl Future<Output = Result<T, BtccError>>,
) -> Result<T, BtccError> {
    let path = data.join("agent-runtime/btcc.sqlite");
    let cancellation = CancellationToken::new();
    let stop = cancellation.clone();
    let scans = scan_loop(path, stop);
    tokio::pin!(serving, scans);
    tokio::select! {
        result = &mut serving => {
            cancellation.cancel();
            scans.await?;
            result
        }
        checked = &mut scans => {
            checked?;
            serving.await
        }
    }
}

async fn scan_loop(path: std::path::PathBuf, stop: CancellationToken) -> Result<(), BtccError> {
    let delay_path = path.clone();
    let delay = tokio::task::spawn_blocking(move || storage_scan_delay(&delay_path))
        .await
        .unwrap_or(Duration::ZERO);
    tokio::select! { () = stop.cancelled() => return Ok(()), () = tokio::time::sleep(delay) => {} }
    let mut retry = Duration::from_secs(5);
    loop {
        let db = path.clone();
        let interrupt = stop.clone();
        let checked =
            tokio::task::spawn_blocking(move || validate_storage_background(&db, interrupt)).await;
        let wait = match checked {
            Ok(Err(error)) if storage_error_is_corruption(&error) => return Err(relay(error)),
            Ok(Ok(())) => {
                butler_core::diagnostic!("[btcc-storage] integrity=ok");
                retry = Duration::from_secs(5);
                Duration::from_secs(24 * 60 * 60)
            }
            other => {
                if stop.is_cancelled() {
                    return Ok(());
                }
                butler_core::diagnostic!(
                    "[btcc-storage] scan_retry={other:?} backoff_s={}",
                    retry.as_secs()
                );
                let wait = retry;
                retry = (retry * 2).min(Duration::from_secs(300));
                wait
            }
        };
        tokio::select! { () = stop.cancelled() => return Ok(()), () = tokio::time::sleep(wait) => {} }
    }
}

fn relay(error: butler_turn::btcc::StorageError) -> BtccError {
    BtccError::relayed("storage_bootstrap_failed", error.to_string()).with_source(error)
}
