//! Terminal source failures, revived only by a validated registration replay.

use rusqlite::{Connection, params};

use super::{GraphProgress, GraphRepository, db_error, jobs};
use crate::cognition::CognitionResult;

pub(super) const CODES: [&str; 4] = [
    "memory_source_changed",
    "memory_source_not_terminal",
    "memory_source_ineligible",
    "memory_source_text_missing",
];

pub(in crate::cognition) fn is_invalid(code: &str) -> bool {
    CODES.contains(&code)
}

/// A turn change only needs extra catch-up work after a terminal source failure;
/// ordinary outcomes continue through the append inventory.
pub(in crate::cognition) fn needs_revalidation(
    db: &Connection,
    source_key: &str,
) -> CognitionResult<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_chunks c \
         JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision \
         JOIN memory_projection_windows w ON w.job_id=j.job_id \
         WHERE c.source_key=?1 AND w.state='failed' AND w.error_code IN (?2,?3,?4,?5))",
        params![source_key, CODES[0], CODES[1], CODES[2], CODES[3]],
        |row| row.get(0),
    ).map_err(db_error)
}

impl GraphRepository {
    /// Pace unavailable sources without claiming or spending a provider attempt.
    pub(in crate::cognition) fn defer_unavailable_source(
        &mut self,
        job: &str,
        now: &str,
    ) -> CognitionResult<GraphProgress> {
        let retry = super::failure::retry_at(now, 1)?;
        let tx = self.connection_mut()?.transaction().map_err(db_error)?;
        tx.execute(
            "UPDATE memory_projection_windows SET next_attempt_at=?2,error_code='memory_write_busy' \
             WHERE job_id=?1 AND state IN ('pending','planned') AND owner_nonce IS NULL \
             AND (next_attempt_at IS NULL OR next_attempt_at<=?3)",
            params![job, retry, now],
        ).map_err(db_error)?;
        jobs::refresh_semantic_state(&tx, job, now)?;
        tx.commit().map_err(db_error)?;
        jobs::progress(self.connection()?, job)
    }

    /// The caller has checked canonical authority under the write lease. Only
    /// unowned, due windows are retired; live claims retain their nonce owner.
    pub(in crate::cognition) fn settle_invalid_source(
        &mut self,
        job: &str,
        code: &str,
        now: &str,
    ) -> CognitionResult<GraphProgress> {
        let tx = self.connection_mut()?.transaction().map_err(db_error)?;
        let changed = tx.execute(
            "UPDATE memory_projection_windows SET state='failed',error_code=?2,next_attempt_at=NULL,owner_pid=NULL,started_at=NULL \
             WHERE job_id=?1 AND state IN ('pending','planned') AND owner_nonce IS NULL \
             AND (next_attempt_at IS NULL OR next_attempt_at<=?3)",
            params![job, code, now],
        ).map_err(db_error)?;
        if changed > 0 {
            jobs::refresh_semantic_state(&tx, job, now)?;
        }
        tx.commit().map_err(db_error)?;
        jobs::progress(self.connection()?, job)
    }
}

/// Called only after registration has validated the current canonical revision.
/// Same-revision undo/restore must not replay a terminal source failure forever.
pub(super) fn revive(db: &Connection, job: &str, now: &str) -> CognitionResult<()> {
    let changed = db.execute(
        "UPDATE memory_projection_windows SET state=CASE WHEN normalized_plan_json IS NOT NULL THEN 'planned' ELSE 'pending' END,\
         error_code=NULL,next_attempt_at=NULL WHERE job_id=?1 AND state='failed' AND error_code IN (?2,?3,?4,?5)",
        params![job, CODES[0], CODES[1], CODES[2], CODES[3]],
    ).map_err(db_error)?;
    if changed > 0 {
        jobs::refresh_semantic_state(db, job, now)?;
    }
    Ok(())
}
