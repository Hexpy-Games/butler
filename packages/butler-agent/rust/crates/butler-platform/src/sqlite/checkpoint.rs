//! Stock commit-path checkpoints with coalesced background WAL-index writeback.
use super as sqlite;
use rusqlite::{Connection, OpenFlags, config::DbConfig};
use std::{
    cell::RefCell,
    marker::PhantomData,
    path::PathBuf,
    rc::Rc,
    sync::mpsc,
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
    /// A background WAL-index sync finished.
    Finished {
        /// Time spent performing this maintenance pass.
        elapsed: Duration,
        /// WAL-index writeback returned success.
        succeeded: bool,
    },
}

/// An optional callback, invoked on the writer or maintenance owner thread.
pub type CheckpointObserver = fn(CheckpointEvent);
type CheckpointResult<T> = Result<T, CheckpointError>;

struct Hook {
    observer: Option<CheckpointObserver>,
    pages: i32,
    wake: mpsc::SyncSender<()>,
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
        let thread = thread::Builder::new()
            .name("sqlite-wal-checkpoint".into())
            .spawn(move || run(&path, synchronous, cache_size, &ready, &requests, observer))?;
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
            // Match SQLite's stock automatic hook: checkpoint before returning
            // from COMMIT, ignoring errors because the transaction committed.
            // A concurrent PASSIVE worker can hold the checkpoint lock while
            // writers keep appending, so checkpoint only on this writer lane.
            let _ = wal.checkpoint();
            // SQLite does not flush mapped WAL-index pages on macOS. Coalesce
            // that separate writeback off the SQL lane, with no idle wakeups.
            // Full means a sync is pending; close reports a disconnected worker.
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
        let synced = sqlite::sync_wal_index(&connection);
        if let Some(observer) = observer {
            observer(CheckpointEvent::Finished {
                elapsed: started.elapsed(),
                succeeded: synced.is_ok(),
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
