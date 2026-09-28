//! The memory write lease around generation stages. Stages that hold the
//! lease run their file and SQLite work on the blocking pool, never on the
//! async runtime.

use std::path::Path;

use tokio_util::sync::CancellationToken;

use crate::cognition::{CognitionCode, CognitionError, CognitionResult};
use crate::coordination::{
    CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator, CognitionWriteLease,
    CoordinationError,
};

/// Waits in the background class for the write lease on `lock_path`. Every
/// failure, including cancellation, reports `memory_write_busy`.
pub(in crate::cognition::generation) async fn acquire(
    coordinator: &CognitionWriteCoordinator,
    lock_path: &Path,
    purpose: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<CognitionWriteLease> {
    wait(coordinator, lock_path, purpose, cancellation)
        .await
        .map_err(|source| busy().with_source(source))?
        .ok_or_else(busy)
}

/// Like [`acquire`], but a caller cancellation observed while waiting is an
/// abort, not contention: `memory_write_busy` is retryable for callers.
pub(in crate::cognition::generation) async fn acquire_abortable(
    coordinator: &CognitionWriteCoordinator,
    lock_path: &Path,
    purpose: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<CognitionWriteLease> {
    wait(coordinator, lock_path, purpose, cancellation)
        .await
        .map_err(|failure| match failure {
            CoordinationError::Aborted => error(CognitionCode::MemoryOperationAborted),
            _ => busy(),
        })?
        .ok_or_else(busy)
}

async fn wait(
    coordinator: &CognitionWriteCoordinator,
    lock_path: &Path,
    purpose: &str,
    cancellation: &CancellationToken,
) -> Result<Option<CognitionWriteLease>, CoordinationError> {
    coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock_path.to_owned(),
                purpose: Some(purpose.to_owned()),
                deadline_at_epoch_ms: None,
                cancellation: Some(cancellation.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
}

/// Runs `stage` with `lease` on the blocking pool, then releases the lease,
/// committing when the stage succeeded. `failed` reports a stage task that
/// could not complete (a panic or runtime shutdown).
pub(in crate::cognition::generation) async fn leased<T: Send + 'static>(
    lease: CognitionWriteLease,
    failed: CognitionCode,
    stage: impl FnOnce(&CognitionWriteLease) -> CognitionResult<T> + Send + 'static,
) -> CognitionResult<T> {
    tokio::task::spawn_blocking(move || {
        let result = stage(&lease);
        let released = lease
            .release(result.is_ok())
            .map_err(|source| busy().with_source(source));
        result.and_then(|value| {
            released?;
            Ok(value)
        })
    })
    .await
    .map_err(|source| error(failed).with_source(source))?
}

/// Releases `lease`, committing when `result` succeeded; the result of the
/// work wins over a release failure.
pub(in crate::cognition::generation) fn finish<T>(
    lease: CognitionWriteLease,
    result: CognitionResult<T>,
) -> CognitionResult<T> {
    let released = lease
        .release(result.is_ok())
        .map_err(|source| busy().with_source(source));
    result.and_then(|value| {
        released?;
        Ok(value)
    })
}

fn busy() -> CognitionError {
    error(CognitionCode::MemoryWriteBusy)
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
