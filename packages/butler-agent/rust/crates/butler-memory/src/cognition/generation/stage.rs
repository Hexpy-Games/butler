//! Generation stages that hold the memory write lease run their file and
//! SQLite work on the blocking pool, never on the async runtime.

use crate::cognition::{CognitionCode, CognitionError, CognitionResult};
use crate::coordination::CognitionWriteLease;

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
        let released = lease.release(result.is_ok()).map_err(|source| {
            CognitionError::new(
                CognitionCode::MemoryWriteBusy,
                CognitionCode::MemoryWriteBusy.as_str(),
            )
            .with_source(source)
        });
        result.and_then(|value| {
            released?;
            Ok(value)
        })
    })
    .await
    .map_err(|source| CognitionError::new(failed, failed.as_str()).with_source(source))?
}
