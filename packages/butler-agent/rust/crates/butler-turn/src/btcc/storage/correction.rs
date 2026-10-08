//! Offline startup correction, before opening any BTCC lane or request surface.
mod compact;
mod reclaim;
mod state;

use super::bootstrap::io_error;
use super::{StorageError, StorageProfile, StorageResult, bootstrap, configure};
use butler_platform::{secure_fs, sqlite};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const BUDGET: Duration = Duration::from_secs(180);

/// Startup result. A rollback link is retained only until the normal open succeeds.
#[derive(Debug)]
pub enum CorrectionOutcome {
    Noop,
    Deferred,
    Reclaimed,
    Compacted { precompact: bool },
}
impl CorrectionOutcome {
    /// Delete the rollback link after the normal storage lane has opened.
    pub fn opened(&self, path: &Path) -> StorageResult<()> {
        remove(&sibling(path, "precompact"))?;
        remove(&sibling(path, "compact-tmp"))
    }
    /// Restore the original atomically, record the permanent open failure.
    pub fn rollback(&self, path: &Path) -> StorageResult<bool> {
        let backup = sibling(path, "precompact");
        if !backup.exists() {
            return Ok(false);
        }
        // A failed lane must have closed all its connections before restoring.
        for suffix in ["-wal", "-shm"] {
            remove(&PathBuf::from(format!("{}{suffix}", path.display())))?;
        }
        secure_fs::rename(&backup, path).map_err(io_error)?;
        secure_fs::sync_path(parent(path)).map_err(io_error)?;
        let db = writer(path)?;
        state::set(
            &db,
            "failed_open",
            false,
            &serde_json::json!({"code":"storage_correction_open_failed"}),
        )?;
        drop(db);
        bootstrap::stamp_verified(path)?;
        Ok(true)
    }
}

pub(super) struct Run<'a> {
    stop: &'a CancellationToken,
    deadline: Instant,
    progress: &'a mut dyn FnMut(&str, Duration, u64),
}
impl Run<'_> {
    fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
    fn hook(&self, db: &rusqlite::Connection) {
        let stop = self.stop.clone();
        let end = self.deadline;
        db.progress_handler(
            1000,
            Some(move || stop.is_cancelled() || Instant::now() >= end),
        );
    }
}

/// Reclaim settled acceptances and, once, compact a verified logical copy.
/// `progress` reports step duration and reclaim WAL bytes without row content.
pub fn run_startup_correction(
    path: &Path,
    stop: &CancellationToken,
    mut progress: impl FnMut(&str, Duration, u64),
) -> StorageResult<CorrectionOutcome> {
    let started = Instant::now();
    let mut run = Run {
        stop,
        deadline: started + BUDGET,
        progress: &mut progress,
    };
    let sidecar = parent(path).join("storage-correction.json");
    // A crash may leave a progress file; its old deadline must never extend this run.
    remove(&sidecar)?;
    let result = execute(path, &mut run);
    let cleaned = remove(&sidecar);
    let outcome = result?;
    cleaned?;
    (run.progress)(
        match outcome {
            CorrectionOutcome::Noop => "outcome=noop",
            CorrectionOutcome::Compacted { .. } => "outcome=compacted",
            CorrectionOutcome::Deferred => "outcome=deferred",
            CorrectionOutcome::Reclaimed => "outcome=reclaimed",
        },
        started.elapsed(),
        0,
    );
    Ok(outcome)
}

fn execute(path: &Path, run: &mut Run<'_>) -> StorageResult<CorrectionOutcome> {
    let tmp = sibling(path, "compact-tmp");
    if tmp.exists() {
        remove(&tmp)?;
        let backup = sibling(path, "precompact");
        if backup.exists() && secure_fs::same_file(&backup, path).map_err(io_error)? {
            remove(&backup)?;
        }
    }
    let db = reader(path)?;
    let initial = state::read(&db)?;
    if let Some(outcome) = fast_path(path, run, &db, &initial)? {
        return Ok(outcome);
    }
    drop(db);
    let mut db = writer(path)?;
    bootstrap::migrate_current(&mut db)?;
    if initial.name.as_deref() == Some("pending_time")
        && state::admission(path, &state::pages(&db)?, run.remaining())? == Some("pending_time")
    {
        state::defer(&db, "pending_time", initial.attempts)?;
        return Ok(CorrectionOutcome::Deferred);
    }
    if initial.name.is_none() {
        let start = Instant::now();
        reclaim::backfill(&mut db)?;
        (run.progress)("backfill", start.elapsed(), 0);
    }
    let current = state::read(&db)?;
    let queued: u64 = db
        .query_row("SELECT count(*) FROM agent_acceptance_reclaims", [], |r| {
            r.get(0)
        })
        .map_err(StorageError::sqlite)?;
    if queued > 32 {
        sidecar(path, "reclaim", run)?;
    }
    run.hook(&db);
    let drained = reclaim::drain(&mut db, run);
    db.progress_handler(0, None::<fn() -> bool>);
    if run.stop.is_cancelled() || run.remaining().is_zero() {
        return Ok(CorrectionOutcome::Deferred);
    }
    if !drained? {
        return Ok(CorrectionOutcome::Deferred);
    }
    if current.name.as_deref() == Some("reclaiming") {
        state::set(&db, "reclaimed", false, &serde_json::json!({}))?;
    }
    let current = state::read(&db)?;
    if matches!(
        current.name.as_deref(),
        Some("reclaimed" | "compacting" | "pending_space" | "pending_time")
    ) {
        compact::run(path, db, current.attempts, run)
    } else {
        Ok(CorrectionOutcome::Noop)
    }
}

fn fast_path(
    path: &Path,
    run: &Run<'_>,
    db: &rusqlite::Connection,
    initial: &state::State,
) -> StorageResult<Option<CorrectionOutcome>> {
    let name = initial.name.as_deref();
    if initial.queued == 0
        && (name == Some("done") || name.is_some_and(|s| s.starts_with("failed_")))
    {
        return Ok(Some(if sibling(path, "precompact").exists() {
            CorrectionOutcome::Compacted { precompact: true }
        } else {
            CorrectionOutcome::Noop
        }));
    }
    if initial.queued == 0 && matches!(name, Some("pending_space" | "pending_time")) {
        let p = state::pages(db)?;
        if state::admission(path, &p, run.remaining())?
            .is_some_and(|s| s == name.unwrap_or_default())
        {
            if name == Some("pending_time") {
                return Ok(None);
            }
            return Ok(Some(CorrectionOutcome::Deferred));
        }
    }
    Ok(None)
}

pub(super) fn writer(path: &Path) -> StorageResult<sqlite::Connection> {
    let db = sqlite::open(path).map_err(StorageError::sqlite)?;
    configure(&db, StorageProfile::Durable)?;
    // Overflow pages must be freed without rewriting their former contents.
    db.pragma_update(None, "secure_delete", false)
        .map_err(StorageError::sqlite)?;
    Ok(db)
}
pub(super) fn reader(path: &Path) -> StorageResult<sqlite::Connection> {
    sqlite::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(StorageError::sqlite)
}
pub(super) fn parent(path: &Path) -> &Path {
    path.parent().unwrap_or(Path::new("."))
}
pub(super) fn sibling(path: &Path, suffix: &str) -> PathBuf {
    path.with_extension(format!("sqlite.{suffix}"))
}
pub(super) fn remove(path: &Path) -> StorageResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_error(e)),
    }
}
fn sidecar(path: &Path, phase: &str, run: &Run<'_>) -> StorageResult<()> {
    use std::io::Write;
    let deadline =
        chrono::Utc::now() + chrono::Duration::from_std(run.remaining()).unwrap_or_default();
    let value = serde_json::json!({"schema":"butler.storage-correction-progress.v1","phase":phase,"deadlineAt":deadline.to_rfc3339()});
    secure_fs::replace_private(
        &parent(path).join("storage-correction.json"),
        |file| {
            file.write_all(value.to_string().as_bytes())
                .map_err(io_error)
        },
        io_error,
    )
}
