//! Deferred validation owns a separate read-only SQLite snapshot, never the
//! Turn writer. A failure exits through the same service error/recovery path
//! as a failed startup validation. Shutdown interrupts and joins the scan.
use std::future::Future;
use std::path::{Path, PathBuf};

use butler_turn::btcc::{BtccError, finish_storage_shutdown, validate_storage_background};
use tokio_util::sync::CancellationToken;

pub(super) async fn while_serving<T>(
    data: &Path,
    serving: impl Future<Output = Result<T, BtccError>>,
) -> Result<T, BtccError> {
    let path = data.join("agent-runtime/btcc.sqlite");
    let cancellation = CancellationToken::new();
    let stop = cancellation.clone();
    let mut scan = tokio::task::spawn_blocking(move || {
        let checked = validate_storage_background(&path, stop);
        if checked.is_ok() {
            butler_core::diagnostic!("[btcc-storage] integrity=ok");
        }
        checked
    });
    tokio::pin!(serving);
    tokio::select! {
        result = &mut serving => {
            cancellation.cancel();
            let checked = scan.await;
            // A deliberate SQLite interrupt is expected only on this branch.
            // Actual corruption must not be hidden by an overlapping stop.
            match checked {
                Ok(Err(error)) if !interrupted(&error) => Err(relay(error)),
                Err(error) => Err(worker(error)),
                _ => result,
            }
        }
        checked = &mut scan => {
            checked.map_err(worker)?.map_err(relay)?;
            serving.await
        }
    }
}

pub(super) async fn clean_shutdown(data: PathBuf) -> Result<(), BtccError> {
    tokio::task::spawn_blocking(move || {
        finish_storage_shutdown(&data.join("agent-runtime/btcc.sqlite"))
    })
    .await
    .map_err(worker)?
    .map_err(relay)
}

fn relay(error: butler_turn::btcc::StorageError) -> BtccError {
    BtccError::relayed("storage_bootstrap_failed", error.to_string()).with_source(error)
}

fn worker(error: tokio::task::JoinError) -> BtccError {
    BtccError::relayed("storage_validation_worker_failed", error.to_string()).with_source(error)
}

fn interrupted(error: &butler_turn::btcc::StorageError) -> bool {
    matches!(error, butler_turn::btcc::StorageError::Sqlite { source }
        if source.sqlite_error_code() == Some(rusqlite::ErrorCode::OperationInterrupted))
}
