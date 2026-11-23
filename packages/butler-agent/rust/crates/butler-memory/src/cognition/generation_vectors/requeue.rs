use std::path::Path;

use butler_platform::sqlite;
use rusqlite::OpenFlags;

use crate::cognition::{CognitionCode, CognitionError, CognitionResult};

/// Re-queues units whose physical vector store was excluded from a restore.
pub fn requeue_vectors(graph_path: &Path) -> CognitionResult<u64> {
    let db = sqlite::open_with_flags(graph_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(graph_error)?;
    db.execute(
        "UPDATE memory_vector_units SET state='pending', error_code=NULL, attempt_count=0,
         next_attempt_at=NULL, owner_pid=NULL, owner_nonce=NULL, started_at=NULL, receipt_json=NULL,
         provider_invoked=0, outcome_known=1, invocation_ref=NULL WHERE state IN ('complete','running')",
        [],
    ).map(|count| count as u64).map_err(graph_error)
}

/// Checks whether units from before the restore still need embeddings.
pub fn vectors_pending_since(graph_path: &Path, since_iso: &str) -> CognitionResult<bool> {
    let db = sqlite::open_with_flags(graph_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(graph_error)?;
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_vector_units u
         JOIN memory_projection_jobs j ON j.job_id=u.job_id
         WHERE u.state='pending' AND j.created_at < ?1)",
        [since_iso],
        |row| row.get(0),
    )
    .map_err(graph_error)
}

fn graph_error(error: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryGraphFailed,
        "Could not access restored vector units",
    )
    .with_source(error)
}
