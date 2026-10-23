//! Change-driven background checkpoints and idle finishes, with a commit-path ceiling.
//! A fully backfilled threshold pass arms one finish on the background connection
//! once the writer lane reports idle. The next writer BEGIN sees nBackfill ==
//! mxFrame and takes read-lock 0; SQLite's walRestartLog resets the WAL on its
//! first frame write. Continuous writes defer this reset until idle, while the
//! 4x inline PASSIVE ceiling bounds growth (unless a reader pins the WAL).
use super as sqlite;
use rusqlite::Connection;
mod worker;
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
    /// A due background pass captured its progress before checkpoint serialization.
    Started,
    /// The writer committed this many frames into its current WAL.
    WalCommitted(i32),
    /// A measured SQLite checkpoint completed on either owner thread.
    Checkpointed {
        /// Whether this work delayed the committing writer.
        inline: bool,
        /// This background pass finishes a fully backfilled threshold snapshot.
        finish: bool,
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
    #[cfg(feature = "test-support")]
    stall_finish: Mutex<Option<Box<dyn FnOnce() + Send>>>,
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
    // Armed once by a fully backfilled threshold pass, consumed only at idle
    // (or cleared on reset / a successful inline ceiling pass).
    finish_pending: bool,
    // Only the dedicated writer lane reports idle; owners default to busy.
    lane_idle: bool,
}
impl Progress {
    fn committed(&mut self, frames: i32) {
        if frames < self.frames {
            self.generation = self.generation.wrapping_add(1);
            self.backfilled = 0;
            self.attempted = 0;
            self.finish_pending = false;
        }
        self.frames = frames;
    }
    fn due(&self, threshold: i32) -> bool {
        // A pinned reader waits for a threshold of new frames after its attempt.
        self.frames
            .saturating_sub(self.backfilled.max(self.attempted))
            >= threshold
    }
    fn completed(&mut self, generation: u64, log: i32, checkpointed: i32) {
        if self.generation == generation && log >= 0 && checkpointed >= 0 {
            self.backfilled = checkpointed;
            self.attempted = log;
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
            #[cfg(feature = "test-support")]
            stall_finish: Mutex::new(None),
        });
        let background = maintenance.clone();
        let thread = thread::Builder::new()
            .name("sqlite-wal-checkpoint".into())
            .spawn(move || {
                worker::run(
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

    /// Mark active or queued lane work. Only takes the short metadata lock.
    pub fn lane_busy(&self) {
        HOOK.with(|hook| {
            if let Some(hook) = hook.borrow().as_ref() {
                hook.maintenance
                    .progress
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .lane_idle = false;
            }
        });
    }

    /// Report an empty, inactive lane and coalesce a pending finish wake.
    /// No SQLite or filesystem work runs here, and sending never waits.
    pub fn lane_idle(&self) {
        HOOK.with(|hook| {
            if let Some(hook) = hook.borrow().as_ref() {
                let mut progress = hook
                    .maintenance
                    .progress
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                progress.lane_idle = true;
                if progress.finish_pending {
                    let _ = hook.wake.try_send(());
                }
            }
        });
    }

    /// Stall one worker finish after PASSIVE, while it holds checkpoint serialization.
    #[cfg(feature = "test-support")]
    pub fn stall_next_finish(&self, stall: impl FnOnce() + Send + 'static) {
        HOOK.with(|hook| {
            if let Some(hook) = hook.borrow().as_ref() {
                *hook
                    .maintenance
                    .stall_finish
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner) = Some(Box::new(stall));
            }
        });
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
        if pages >= hook.pages.saturating_mul(HARD_LIMIT_MULTIPLIER) {
            due = writer_pass(wal, pages, hook);
        }
        if due {
            let _ = wake.try_send(());
        }
    });
    Ok(())
}

fn writer_pass(wal: &rusqlite::hooks::Wal, pages: i32, hook: &Maintenance) -> bool {
    // Only the hard ceiling may delay a committing writer for maintenance.
    let started = Instant::now();
    let guard = hook
        .checkpoint
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let result = wal.checkpoint_v2(rusqlite::hooks::CheckpointMode::PASSIVE);
    let due = {
        let mut progress = hook.progress.lock().unwrap_or_else(PoisonError::into_inner);
        if let Ok((log, backfilled)) = result.as_ref() {
            let generation = progress.generation;
            progress.completed(generation, *log, *backfilled);
            // A background pass may have completed while acquiring the lock.
            // This writer pass has already consumed that work, even if pinned.
            progress.finish_pending = false;
        }
        progress.due(hook.pages)
    };
    drop(guard);
    checkpointed(
        hook,
        "inline",
        result.as_ref().copied().unwrap_or((pages, -1)),
        started.elapsed(),
        result.is_ok(),
    );
    due
}

fn checkpointed(
    maintenance: &Maintenance,
    mode: &str,
    counts: (i32, i32),
    elapsed: Duration,
    succeeded: bool,
) {
    let (frames, backfilled) = counts;
    let Maintenance {
        observer, label, ..
    } = maintenance;
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if *ENABLED.get_or_init(|| {
        std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
            == Some(std::ffi::OsStr::new("1"))
    }) {
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
            inline: mode == "inline",
            finish: mode == "finish",
            elapsed,
            frames,
            succeeded,
        });
    }
}
