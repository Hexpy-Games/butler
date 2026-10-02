//! Stub-only kill point after a real gram insert, before its transaction commits.
use crate::cognition::{CognitionCode, CognitionError, CognitionResult};
use rusqlite::Connection;
use tokio_util::sync::CancellationToken;

pub(super) fn hold(db: &Connection, stop: &CancellationToken) -> CognitionResult<()> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub")
        || std::env::var("BUTLER_E2E_ALIAS_BATCH_HOLD").as_deref() != Ok("1")
    {
        return Ok(());
    }
    let path =
        std::path::PathBuf::from(db.path().unwrap_or_default()).with_extension("alias-batch-held");
    std::fs::write(&path, b"uncommitted gram")
        .map_err(|e| CognitionError::new(CognitionCode::MemoryGraphUnavailable, e.to_string()))?;
    while !stop.is_cancelled() {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let _ = std::fs::remove_file(path);
    Err(super::aborted())
}
