use rusqlite::{Connection, params};

use super::super::{StorageError, StorageResult};

pub(super) const CLOSE_SOURCE_WORK: &str = "UPDATE btcc_authority_requests SET close_reason = 'work_abandoned', \
         close_scope = 'work', closed_at = ?1, updated_at = ?1 \
         WHERE source_work_id = ?2 AND decision = 'pending' AND close_reason IS NULL";
pub(super) const CLOSE_OWNER: &str = "UPDATE btcc_authority_requests SET close_reason=?1, close_scope='self_session', \
         closed_at=?2, updated_at=?2 WHERE owner_session_id=?3 AND (?1 IN ('session_archived','session_permanently_deleted') OR source_session_id=?3) \
         AND decision='pending' AND close_reason IS NULL";

/// Exact source Work and pending undecided request selection; caller owns the transaction.
pub(in crate::btcc::storage) fn close_pending_source_work_requests(
    db: &Connection,
    source_work_id: &str,
    now: &str,
) -> StorageResult<usize> {
    db.execute(CLOSE_SOURCE_WORK, params![now, source_work_id])
        .map_err(StorageError::sqlite)
}

/// Shared by public authority close and the existing Turn-stop transaction.
pub(in crate::btcc::storage) fn close_pending_self_session_requests(
    db: &Connection,
    session_id: &str,
    reason: &str,
    now: &str,
) -> StorageResult<usize> {
    if matches!(reason, "session_archived" | "session_permanently_deleted") {
        let receipt = serde_json::json!({
            "status":"closed", "message_id":format!("close-{session_id}"), "reason":reason
        })
        .to_string();
        db.execute(
            super::pending_asks::CLOSE_QUESTIONS,
            params![session_id, receipt, now],
        )
        .map_err(StorageError::sqlite)?;
    }
    db.execute(CLOSE_OWNER, params![reason, now, session_id])
        .map_err(StorageError::sqlite)
}
