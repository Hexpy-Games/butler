//! Coalesced PASSIVE checkpoints on an owned connection, outside the SQL lane.
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
    /// A background PASSIVE checkpoint and WAL-index sync finished.
    Finished {
        /// Time spent performing this maintenance pass.
        elapsed: Duration,
        /// Both SQLite and WAL-index writeback returned success.
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
            // Every commit above the threshold must leave a pending pass. A
            // moving threshold strands a sub-threshold tail after each burst,
            // preventing the next transaction from restarting the WAL.
            match hook.wake.try_send(()) {
                Ok(()) | Err(mpsc::TrySendError::Full(())) => {}
                Err(mpsc::TrySendError::Disconnected(())) => {
                    // Retain SQLite's stock recovery behavior after worker loss.
                    // Closing the owner still reports the maintenance failure.
                    let _ = wal.checkpoint();
                }
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
        let result = backfill(&connection);
        let synced = sqlite::sync_wal_index(&connection);
        // SQLite's automatic hook ignores checkpoint errors after COMMIT. Keep
        // that behavior; the next commit above the threshold requests a pass.
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

fn backfill(connection: &Connection) -> rusqlite::Result<()> {
    let mut previous = -1;
    loop {
        let (busy, log, checkpointed): (i32, i32, i32) =
            connection.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
        if busy != 0 || checkpointed >= log || checkpointed <= previous {
            // PASSIVE reports busy=0 even when a reader pins the unbackfilled
            // tail. Stop on no progress as well; only new commits wake us.
            return Ok(());
        }
        previous = checkpointed;
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
