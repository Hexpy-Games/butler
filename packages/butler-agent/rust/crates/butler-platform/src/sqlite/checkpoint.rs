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

struct Hook {
    observer: Option<CheckpointObserver>,
    pages: i32,
    wake: mpsc::SyncSender<()>,
    checkpoint: Arc<Mutex<()>>,
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
    pub fn start(
        db: &Connection,
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
        let checkpoint = Arc::new(Mutex::new(()));
        let background = checkpoint.clone();
        let thread = thread::Builder::new()
            .name("sqlite-wal-checkpoint".into())
            .spawn(move || {
                run(
                    &path,
                    synchronous,
                    cache_size,
                    &ready,
                    &requests,
                    observer,
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
            *hook.borrow_mut() = Some(Hook {
                observer,
                pages,
                wake,
                checkpoint,
            });
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
        if let Some(observer) = hook.observer {
            observer(CheckpointEvent::WalCommitted(pages));
        }
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
                let result = wal.checkpoint();
                drop(guard);
                checkpointed(
                    hook.observer,
                    true,
                    pages,
                    started.elapsed(),
                    result.is_ok(),
                );
            }
            // Every commit above threshold leaves a coalesced request, including
            // a small final tail behind a pass that has already backfilled.
            // No timers: quiet or pinned WALs do not cause idle checkpoint work.
            let _ = hook.wake.try_send(());
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
    observer: Option<CheckpointObserver>,
    checkpoint: &Mutex<()>,
) -> CheckpointResult<()> {
    let opened = open(path, synchronous, cache_size);
    let connection = match opened {
        Ok(connection) => connection,
        Err(error) => {
            let _ = ready.send(Err(error));
            return Ok(());
        }
    };
    let _ = ready.send(Ok(()));
    while requests.recv().is_ok() {
        let started = Instant::now();
        let guard = checkpoint.lock().unwrap_or_else(PoisonError::into_inner);
        let result = connection.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
            Ok((row.get::<_, i32>(0)?, row.get::<_, i32>(1)?))
        });
        drop(guard);
        let elapsed = started.elapsed();
        let (busy, frames) = result.as_ref().copied().unwrap_or((1, -1));
        checkpointed(observer, false, frames, elapsed, busy == 0);
        // Preserve mapped WAL-index writeback on macOS, outside the SQL lane.
        let synced = sqlite::sync_wal_index(&connection);
        if let Some(observer) = observer {
            observer(CheckpointEvent::Finished {
                elapsed: started.elapsed(),
                succeeded: result.is_ok() && synced.is_ok(),
            });
        }
    }
    connection
        .close()
        .map_err(|(_, error)| CheckpointError::from(error))
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
    inline: bool,
    frames: i32,
    elapsed: Duration,
    succeeded: bool,
) {
    if std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
        == Some(std::ffi::OsStr::new("1"))
    {
        let mode = if inline { "inline" } else { "background" };
        let utc_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros();
        eprintln!(
            "command_checkpoint_timing mode={mode} utc_us={utc_us} frames={frames} checkpoint_us={} succeeded={succeeded}",
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
