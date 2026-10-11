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
    Compacted { swapped: bool },
}
impl CorrectionOutcome {
    /// Delete the rollback link after the normal storage lane has opened.
    pub fn opened(&self, path: &Path) {
        cleanup(&sibling(path, "precompact"));
        cleanup(&sibling(path, "compact-tmp"));
    }
    /// Restore the original atomically, record the permanent open failure.
    pub fn rollback(&self, path: &Path) -> StorageResult<bool> {
        let backup = sibling(path, "precompact");
        if !matches!(self, Self::Compacted { swapped: true }) || !has_backup(path)? {
            return Ok(false);
        }
        // A failed lane must have closed all its connections before restoring.
        for suffix in ["-wal", "-shm"] {
            remove(&PathBuf::from(format!("{}{suffix}", path.display())))?;
        }
        secure_fs::rename(&backup, path).map_err(io_error)?;
        if let Err(error) = secure_fs::sync_path(parent(path)) {
            butler_core::diagnostic!("[btcc-storage] rollback sync: {error}");
        }
        let recorded = writer(path).and_then(|db| {
            state::set(
                &db,
                "failed_open",
                false,
                &serde_json::json!({"code":"storage_correction_open_failed"}),
            )
        });
        if let Err(error) = recorded.and_then(|()| bootstrap::stamp_verified(path)) {
            butler_core::diagnostic!("[btcc-storage] rollback marker: {error}");
        }
        Ok(true)
    }
}

pub(super) struct Run<'a> {
    stop: &'a CancellationToken,
    deadline: Instant,
    progress: &'a mut dyn FnMut(&str, Duration, u64),
    swapped: bool,
    failure_state: &'static str,
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
) -> CorrectionOutcome {
    let started = Instant::now();
    let mut run = Run {
        stop,
        deadline: started + BUDGET,
        progress: &mut progress,
        swapped: false,
        failure_state: "failed_correction",
    };
    let sidecar = parent(path).join("storage-correction.json");
    // A crash may leave a progress file; its old deadline must never extend this run.
    cleanup(&sidecar);
    let outcome = match execute(path, &mut run) {
        Ok(outcome) => outcome,
        Err(error) => recover_error(path, &error, &run),
    };
    cleanup(&sidecar);
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
    outcome
}

fn execute(path: &Path, run: &mut Run<'_>) -> StorageResult<CorrectionOutcome> {
    let backup = sibling(path, "precompact");
    if backup.exists() && secure_fs::same_file(&backup, path).map_err(io_error)? {
        remove(&backup)?;
    }
    remove(&sibling(path, "compact-tmp"))?;
    let db = reader(path)?;
    let initial = state::read(&db)?;
    if initial.name.as_deref() == Some("compacting") && initial.attempts >= 2 {
        drop(db);
        state::set(
            &*writer(path)?,
            "failed_copy",
            false,
            &serde_json::json!({"code":"interrupted_copy"}),
        )?;
        return Ok(CorrectionOutcome::Deferred);
    }
    if let Some(outcome) = fast_path(path, run, &db, &initial)? {
        return Ok(outcome);
    }
    drop(db);
    let db = writer(path)?;
    // An estimated-time deferral only updates its bounded retry marker; it
    // must not rerun migration or reclaim while compaction is inadmissible.
    if initial.name.as_deref() == Some("pending_time")
        && initial.queued == 0
        && state::admission(path, &state::pages(&db)?, run.remaining())? == Some("pending_time")
    {
        state::defer(&db, "pending_time", initial.attempts)?;
        return Ok(CorrectionOutcome::Deferred);
    }
    reclaim_and_compact(path, db, &initial, run)
}

fn reclaim_and_compact(
    path: &Path,
    mut db: sqlite::Connection,
    initial: &state::State,
    run: &mut Run<'_>,
) -> StorageResult<CorrectionOutcome> {
    run.failure_state = "reclaiming";
    run.hook(&db);
    bootstrap::migrate_current(&mut db)?;
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
        return Ok(Some(if has_backup(path)? {
            CorrectionOutcome::Compacted { swapped: false }
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

fn has_backup(path: &Path) -> StorageResult<bool> {
    let backup = sibling(path, "precompact");
    Ok(backup.exists() && !secure_fs::same_file(&backup, path).map_err(io_error)?)
}

fn cleanup(path: &Path) {
    if let Err(error) = remove(path) {
        butler_core::diagnostic!("[btcc-storage] correction cleanup: {error}");
    }
}

fn recover_error(path: &Path, error: &StorageError, run: &Run<'_>) -> CorrectionOutcome {
    butler_core::diagnostic!("[btcc-storage] correction deferred: {error}");
    let transient = matches!(error, StorageError::Sqlite { source } if matches!(
        source.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            | rusqlite::ErrorCode::DiskFull | rusqlite::ErrorCode::OperationInterrupted)
    ));
    // Reclaim transactions roll back independently; keep their queue for another start.
    let state = if run.failure_state == "reclaiming" {
        "reclaiming"
    } else if transient || run.stop.is_cancelled() || run.remaining().is_zero() {
        "pending_space"
    } else {
        run.failure_state
    };
    let recorded = writer(path)
        .and_then(|db| state::set(&db, state, false, &serde_json::json!({"code":error.code()})));
    if let Err(error) = recorded {
        butler_core::diagnostic!("[btcc-storage] correction state not recorded: {error}");
    }
    if run.swapped {
        CorrectionOutcome::Compacted { swapped: true }
    } else {
        CorrectionOutcome::Deferred
    }
}
