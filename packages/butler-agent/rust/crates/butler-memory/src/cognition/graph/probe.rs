//! Read-only questions the idle poll asks before it takes the write lease:
//! is there anything a writer would change?

use rusqlite::Connection;

use super::db_error;
use crate::cognition::CognitionResult;

/// Whether a window is held by an owner that may have died, so that recovery
/// has something to look at. Recovery itself runs under the lease.
pub(super) fn has_recoverable_windows(connection: &Connection) -> CognitionResult<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_projection_windows \
             WHERE state IN ('running','planned') AND owner_nonce IS NOT NULL)",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)
}

/// Whether a vector claim would find anything: a unit left running (recovery
/// applies) or a pending unit of a job whose semantic stage is complete.
pub(super) fn has_vector_work(connection: &Connection, now: &str) -> CognitionResult<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_vector_units WHERE state='running') \
             OR EXISTS(SELECT 1 FROM memory_vector_units u \
               JOIN memory_projection_jobs j ON j.job_id=u.job_id \
               JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision \
               WHERE u.state='pending' AND json_extract(j.semantic_graph_state,'$.state')='complete' \
                 AND (u.next_attempt_at IS NULL OR u.next_attempt_at<=?1))",
            [now],
            |row| row.get(0),
        )
        .map_err(db_error)
}

/// Bounded pending-state index walk, used only after text work advances.
pub(super) fn vector_batch_due(
    connection: &Connection,
    cutoff: &str,
    cap: usize,
) -> CognitionResult<bool> {
    connection
        .query_row(
            "SELECT COUNT(*)>?2 OR COALESCE(MIN(created_at)<=?1,0) FROM (\
             SELECT j.created_at FROM memory_vector_units u \
             JOIN memory_projection_jobs j ON j.job_id=u.job_id \
             JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision \
             WHERE u.state='pending' AND json_extract(j.semantic_graph_state,'$.state')='complete' \
             LIMIT ?3)",
            rusqlite::params![cutoff, cap, cap + 1],
            |row| row.get(0),
        )
        .map_err(db_error)
}
