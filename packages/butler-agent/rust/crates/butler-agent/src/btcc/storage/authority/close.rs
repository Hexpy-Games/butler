use rusqlite::{Connection, params};

use super::super::{StorageError, StorageResult};

/// Exact source Work and pending undecided request selection; caller owns the transaction.
pub(in crate::btcc::storage) fn close_pending_source_work_requests(
    db: &Connection,
    source_work_id: &str,
    now: &str,
) -> StorageResult<usize> {
    db.execute(
        "UPDATE btcc_authority_requests SET close_reason = 'work_abandoned', \
         close_scope = 'work', closed_at = ?1, updated_at = ?1 \
         WHERE source_work_id = ?2 AND decision = 'pending' AND close_reason IS NULL",
        params![now, source_work_id],
    )
    .map_err(StorageError::sqlite)
}

/// Shared by public authority close and the existing Turn-stop transaction.
pub(in crate::btcc::storage) fn close_pending_self_session_requests(
    db: &Connection,
    session_id: &str,
    reason: &str,
    now: &str,
) -> StorageResult<usize> {
    db.execute(
        "UPDATE btcc_authority_requests SET close_reason=?1, close_scope='self_session', \
         closed_at=?2, updated_at=?2 WHERE owner_session_id=?3 AND source_session_id=?3 \
         AND decision='pending' AND close_reason IS NULL",
        params![reason, now, session_id],
    )
    .map_err(StorageError::sqlite)
}
