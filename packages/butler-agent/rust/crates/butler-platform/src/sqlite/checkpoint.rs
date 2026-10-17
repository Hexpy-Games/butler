//! Change-driven background checkpoints with a serialized commit-path backstop.
use super as sqlite;
use rusqlite::{Connection, OpenFlags, config::DbConfig};
use std::{
    cell::RefCell,
    marker::PhantomData,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, Mutex, PoisonError, mpsc},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, thiserror::Error)]
/// Failure to initialize or drain an owned SQLite checkpoint worker.
pub enum CheckpointError {
    /// SQLite rejected a maintenance connection operation.
    #[error("Checkpoint SQLite operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The worker thread could not be started.
    #[error("Checkpoint worker I/O failed: {0}")]
    Io(#[from] std::io::Error),
    /// The startup reply channel closed before initialization completed.
    #[error("Checkpoint worker exited during initialization")]
    Disconnected,
    /// The owned maintenance thread panicked.
    #[error("Checkpoint worker panicked")]
    Panicked,
    /// A WAL connection did not identify its backing file.
    #[error("WAL database path is missing")]
    MissingPath,
    /// This thread already owns another checkpoint hook.
    #[error("A checkpoint owner is already installed on this writer thread")]
    AlreadyInstalled,
}

#[derive(Clone, Copy)]
/// Content-free observations from the writer hook and maintenance thread.
pub enum CheckpointEvent {
    /// The writer committed this many frames into its current WAL.
    WalCommitted(i32),
    /// A measured SQLite checkpoint completed on either owner thread.
    Checkpointed {
        /// Whether this work delayed the committing writer.
        inline: bool,
        /// Checkpoint time, including backstop serialization with a running pass.
        elapsed: Duration,
        /// Frames in the WAL when the checkpoint was requested or observed.
        frames: i32,
        /// The checkpoint call returned success (readers may still pin frames).
        succeeded: bool,
    },
    /// A background checkpoint and WAL-index sync finished.
    Finished {
        /// Time spent performing this maintenance pass.
        elapsed: Duration,
        /// SQLite and WAL-index writeback returned success.
        succeeded: bool,
    },
}

/// An optional callback, invoked on the writer or maintenance owner thread.
pub type CheckpointObserver = fn(CheckpointEvent);
type CheckpointResult<T> = Result<T, CheckpointError>;

// Bound small-transaction growth even when continuous appends outrun PASSIVE.
// SQLite still cannot recycle frames pinned by a reader, or split a transaction.
const HARD_LIMIT_MULTIPLIER: i32 = 4;

struct Maintenance {
    observer: Option<CheckpointObserver>,
    label: &'static str,
    pages: i32,
    progress: Mutex<Progress>,
    checkpoint: Mutex<()>,
}
struct Hook {
    maintenance: Arc<Maintenance>,
    wake: mpsc::SyncSender<()>,
}
// A short metadata lock, never held during SQLite or filesystem work.
#[derive(Default)]
struct Progress {
    frames: i32,
    generation: u64,
    backfilled: i32,
    attempted: i32,
    inline_pending: bool,
}
impl Progress {
    fn committed(&mut self, frames: i32) {
        if frames < self.frames {
            self.generation = self.generation.wrapping_add(1);
            self.backfilled = 0;
            self.attempted = 0;
        }
        self.frames = frames;
    }
    fn due(&self, threshold: i32) -> bool {
        // Commits after a completed pass wait for new frames even when a
        // current reader prevents SQLite from restarting a fully backfilled WAL.
        self.inline_pending
            || self
                .frames
                .saturating_sub(self.backfilled.max(self.attempted))
                >= threshold
    }
    fn completed(&mut self, snapshot: (u64, i32), log: i32, checkpointed: i32) {
        let (generation, attempted) = snapshot;
        if self.generation == generation && log >= 0 && checkpointed >= 0 {
            self.backfilled = checkpointed;
            // SQLite may report a log larger than the snapshot it backfilled.
            // Only a pass blocked before its starting snapshot waits a threshold.
            self.attempted = if checkpointed >= attempted {
                checkpointed
            } else {
                log
            };
        }
    }
}
thread_local! { static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) }; }

/// Installed and closed on the writer's owner thread. Closing drains the last
/// coalesced request before the writer performs its final durable WAL sync.
pub struct CheckpointOwner {
    thread: Option<thread::JoinHandle<CheckpointResult<()>>>,
    _owner_thread: PhantomData<Rc<()>>,
}

impl CheckpointOwner {
    /// Replace this thread's single writer connection's automatic WAL hook.
    /// Retain the owner until writer shutdown; close it before the final WAL sync.
    /// Non-WAL connections and explicitly disabled thresholds need no owner.
    /// The caller supplies a content-free database label for diagnostics.
    pub fn start(
        db: &Connection,
        label: &'static str,
        observer: Option<CheckpointObserver>,
    ) -> CheckpointResult<Option<Self>> {
        let mode: String = db.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        let pages: i32 = db.query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))?;
        if mode != "wal" || pages <= 0 {
            return Ok(None);
        }
        if HOOK.with(|hook| hook.borrow().is_some()) {
            return Err(CheckpointError::AlreadyInstalled);
        }
        let path = db
            .path()
            .filter(|path| !path.is_empty())
            .ok_or(CheckpointError::MissingPath)?;
        let path = PathBuf::from(path);
        let synchronous: i64 = db.query_row("PRAGMA synchronous", [], |row| row.get(0))?;
        let cache_size: i64 = db.query_row("PRAGMA cache_size", [], |row| row.get(0))?;
        let (wake, requests) = mpsc::sync_channel(1);
        let (ready, initialized) = mpsc::sync_channel(1);
        let maintenance = Arc::new(Maintenance {
            observer,
            label,
            pages,
            progress: Mutex::new(Progress::default()),
            checkpoint: Mutex::new(()),
        });
        let background = maintenance.clone();
        let thread = thread::Builder::new()
            .name("sqlite-wal-checkpoint".into())
            .spawn(move || {
                run(
                    &path,
                    synchronous,
                    cache_size,
                    &ready,
                    &requests,
                    &background,
                )
            })?;
        let owner = Self {
            thread: Some(thread),
            _owner_thread: PhantomData,
        };
        initialized
            .recv()
            .map_err(|_| CheckpointError::Disconnected)??;
        HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Hook { maintenance, wake });
        });
        db.wal_hook(Some(committed));
        Ok(Some(owner))
    }

    /// Drain the pending request and join maintenance on the writer's thread.
    pub fn close(mut self) -> CheckpointResult<()> {
        self.finish()
    }

    fn finish(&mut self) -> CheckpointResult<()> {
        HOOK.with(|hook| hook.borrow_mut().take());
        if let Some(thread) = self.thread.take() {
            thread.join().map_err(|_| CheckpointError::Panicked)??;
        }
        Ok(())
    }
}

impl Drop for CheckpointOwner {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

fn committed(wal: &rusqlite::hooks::Wal, pages: i32) -> rusqlite::Result<()> {
    HOOK.with(|hook| {
        let hook = hook.borrow();
        let Some(hook) = hook.as_ref() else { return };
        let wake = &hook.wake;
        let hook = &hook.maintenance;
        if let Some(observer) = hook.observer {
            observer(CheckpointEvent::WalCommitted(pages));
        }
        let mut due = {
            let mut progress = hook.progress.lock().unwrap_or_else(PoisonError::into_inner);
            progress.committed(pages);
            progress.due(hook.pages)
        };
        if pages >= hook.pages {
            if pages >= hook.pages.saturating_mul(HARD_LIMIT_MULTIPLIER) {
                // Wait for the owned PASSIVE pass before running the backstop:
                // racing it would return BUSY and let continuous appends escape
                // the ceiling. Normal commits never take this mutex.
                let started = Instant::now();
                let guard = hook
                    .checkpoint
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                // Same PASSIVE backstop as checkpoint(), with result counters.
                let result = wal.checkpoint_v2(rusqlite::hooks::CheckpointMode::PASSIVE);
                if let Ok((log, backfilled)) = result.as_ref() {
                    let mut progress = hook.progress.lock().unwrap_or_else(PoisonError::into_inner);
                    let generation = progress.generation;
                    progress.completed((generation, pages), *log, *backfilled);
                    // The worker still owns WAL-index sync after an inline pass.
                    progress.inline_pending |= log == backfilled;
                    due = progress.due(hook.pages);
                }
                drop(guard);
                checkpointed(
                    hook.observer,
                    hook.label,
                    true,
                    result.as_ref().copied().unwrap_or((pages, -1)),
                    started.elapsed(),
                    result.is_ok(),
                );
            }
            if due {
                let _ = wake.try_send(());
            }
        }
    });
    Ok(())
}

fn run(
    path: &std::path::Path,
    synchronous: i64,
    cache_size: i64,
    ready: &mpsc::SyncSender<CheckpointResult<()>>,
    requests: &mpsc::Receiver<()>,
    maintenance: &Maintenance,
) -> CheckpointResult<()> {
    let Maintenance {
        checkpoint,
        progress,
        pages,
        ..
    } = maintenance;
    let pages = *pages;
    let opened = open(path, synchronous, cache_size);
    let connection = match opened {
        Ok(connection) => connection,
        Err(error) => {
            let _ = ready.send(Err(error));
            return Ok(());
        }
    };
    let _ = ready.send(Ok(()));
    let mut follow_up = false;
    while follow_up || requests.recv().is_ok() {
        let started = Instant::now();
        let guard = checkpoint.lock().unwrap_or_else(PoisonError::into_inner);
        let snapshot = {
            let mut progress = progress.lock().unwrap_or_else(PoisonError::into_inner);
            // A coalesced wake may be left behind a pass that already covered
            // its frames. Do not run another SQL checkpoint for that request.
            if !follow_up && !progress.due(pages) {
                continue;
            }
            progress.inline_pending = false;
            progress.attempted = progress.frames;
            (progress.generation, progress.frames)
        };
        let result = backfill(&connection, maintenance, started);
        follow_up = if let Ok((_, log, backfilled)) = result.as_ref() {
            let mut progress = progress.lock().unwrap_or_else(PoisonError::into_inner);
            progress.completed(snapshot, *log, *backfilled);
            // Only a due pass may drain commits that raced its backfill. A
            // follow-up's tail, and commits after this lock, wait for due().
            !follow_up
                && progress.generation == snapshot.0
                && *backfilled >= snapshot.1
                && progress.frames > *backfilled
        } else {
            false
        };
        drop(guard);
        finish_pass(&connection, maintenance, started, result.is_ok());
    }
    connection
        .close()
        .map_err(|(_, error)| CheckpointError::from(error))
}

fn backfill(
    connection: &sqlite::Connection,
    maintenance: &Maintenance,
    started: Instant,
) -> rusqlite::Result<(i32, i32, i32)> {
    let result = connection.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
        Ok((
            row.get::<_, i32>(0)?,
            row.get::<_, i32>(1)?,
            row.get::<_, i32>(2)?,
        ))
    });
    let (busy, log, backfilled) = result.as_ref().copied().unwrap_or((1, -1, -1));
    checkpointed(
        maintenance.observer,
        maintenance.label,
        false,
        (log, backfilled),
        started.elapsed(),
        busy == 0,
    );
    result
}

fn finish_pass(
    connection: &sqlite::Connection,
    maintenance: &Maintenance,
    started: Instant,
    succeeded: bool,
) {
    // Preserve mapped WAL-index writeback on macOS, outside the SQL lane.
    let synced = sqlite::sync_wal_index(connection);
    if let Some(observer) = maintenance.observer {
        observer(CheckpointEvent::Finished {
            elapsed: started.elapsed(),
            succeeded: succeeded && synced.is_ok(),
        });
    }
}

fn open(
    path: &std::path::Path,
    synchronous: i64,
    cache_size: i64,
) -> CheckpointResult<sqlite::Connection> {
    let connection = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    connection.pragma_update(None, "synchronous", synchronous)?;
    connection.pragma_update(None, "cache_size", cache_size)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)?;
    Ok(connection)
}

fn checkpointed(
    observer: Option<CheckpointObserver>,
    label: &'static str,
    inline: bool,
    counts: (i32, i32),
    elapsed: Duration,
    succeeded: bool,
) {
    let (frames, backfilled) = counts;
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if *ENABLED.get_or_init(|| {
        std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
            == Some(std::ffi::OsStr::new("1"))
    }) {
        let mode = if inline { "inline" } else { "background" };
        let utc_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros();
        let start_utc_us = utc_us.saturating_sub(elapsed.as_micros());
        eprintln!(
            "command_checkpoint_timing db={label} mode={mode} utc_us={utc_us} start_utc_us={start_utc_us} frames={frames} log={frames} checkpointed={backfilled} checkpoint_us={} succeeded={succeeded}",
            elapsed.as_micros()
        );
    }
    if let Some(observer) = observer {
        observer(CheckpointEvent::Checkpointed {
            inline,
            elapsed,
            frames,
            succeeded,
        });
    }
}
