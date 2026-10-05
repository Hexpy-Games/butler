//! Suppressed queue notices receive a durable disposition before their queue acknowledgement.
use super::*;
use butler_platform::sqlite;
use rusqlite::OpenFlags;
pub(super) async fn ack(
    input: &Input,
    root: &std::path::Path,
    job: &str,
    turn: &str,
) -> CognitionResult<bool> {
    let owned = input.clone();
    let turn_id = turn.to_owned();
    let suppressed = super::super::blocking::run(move || {
        let active = resolve_active_generation(&owned.data_root, &owned.environment)?;
        let db = sqlite::open_with_flags(active.graph_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(failed)?;
        crate::coordination::admission_suppressed(&db, "turn", &turn_id).map_err(failed)
    })
    .await?;
    if !suppressed {
        return Ok(false);
    }
    let owned = input.clone();
    let turn_id = turn.to_owned();
    let job_id = job.to_owned();
    super::super::blocking::run(move || {
        let lease = owned.coordinator.try_acquire(&crate::coordination::CognitionWriteAcquire::immediate(owned.environment.consolidation_lock(&owned.data_root), "reset_suppressed"))
            .map_err(CognitionError::from)?.ok_or_else(|| failed(std::io::Error::other("Memory is in use")))?;
        let active = resolve_active_generation(&owned.data_root, &owned.environment)?;
        crate::cognition::ensure_data_authority(&owned.data_root, &[&active.graph_path])?;
        let db = sqlite::open(&active.graph_path).map_err(failed)?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS memory_reset_suppressed_notices(job_id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,disposition TEXT NOT NULL)").map_err(failed)?;
        db.execute("INSERT OR IGNORE INTO memory_reset_suppressed_notices VALUES(?1,?2,'reset-suppressed')", (job_id, turn_id)).map_err(failed)?;
        lease.release(true).map_err(CognitionError::from)
    }).await?;
    super::super::blocking::ack(root, job).await
}
fn failed(source: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryGenerationUnavailable,
        "Reset disposition unavailable",
    )
    .with_source(source)
}
