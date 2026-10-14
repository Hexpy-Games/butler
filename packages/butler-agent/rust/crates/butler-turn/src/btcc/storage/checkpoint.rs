//! Coalesced PASSIVE checkpoints on an owned connection, outside the SQL lane.
use super::{StorageCode, StorageError, StorageResult, timing};
use butler_platform::sqlite;
use rusqlite::{Connection, OpenFlags, config::DbConfig};
use std::{cell::RefCell, marker::PhantomData, path::PathBuf, rc::Rc, sync::mpsc, thread};

struct Hook {
    pages: i32,
    next_pages: i32,
    last_pages: i32,
    wake: mpsc::SyncSender<()>,
}
thread_local! { static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) }; }

/// Installed and closed on the writer's owner thread. Closing drains the last
/// coalesced request before the writer performs its final durable WAL sync.
pub(super) struct CheckpointOwner {
    thread: Option<thread::JoinHandle<StorageResult<()>>>,
    _owner_thread: PhantomData<Rc<()>>,
}

impl CheckpointOwner {
    pub(super) fn start(db: &Connection) -> StorageResult<Option<Self>> {
        let mode: String = db
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .map_err(StorageError::sqlite)?;
        let pages: i32 = db
            .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
            .map_err(StorageError::sqlite)?;
        if mode != "wal" || pages <= 0 {
            return Ok(None);
        }
        let path = db.path().filter(|path| !path.is_empty()).ok_or_else(|| {
            StorageError::new(
                StorageCode::SqliteInitializationChannelClosed,
                "WAL database path is missing",
            )
        })?;
        let path = PathBuf::from(path);
        let synchronous: i64 = db
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .map_err(StorageError::sqlite)?;
        let cache_size: i64 = db
            .query_row("PRAGMA cache_size", [], |row| row.get(0))
            .map_err(StorageError::sqlite)?;
        let (wake, requests) = mpsc::sync_channel(1);
        let (ready, initialized) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("btcc-wal-checkpoint".into())
            .spawn(move || run(&path, synchronous, cache_size, &ready, &requests))
            .map_err(|error| {
                StorageError::new(StorageCode::SqliteThreadSpawnFailed, error.to_string())
                    .with_source(error)
            })?;
        let owner = Self {
            thread: Some(thread),
            _owner_thread: PhantomData,
        };
        initialized.recv().map_err(|error| {
            StorageError::new(
                StorageCode::SqliteInitializationChannelClosed,
                "Checkpoint worker exited during initialization",
            )
            .with_source(error)
        })??;
        HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Hook {
                pages,
                next_pages: pages,
                last_pages: 0,
                wake,
            });
        });
        db.wal_hook(Some(committed));
        Ok(Some(owner))
    }

    pub(super) fn close(mut self) -> StorageResult<()> {
        self.finish()
    }

    fn finish(&mut self) -> StorageResult<()> {
        HOOK.with(|hook| hook.borrow_mut().take());
        if let Some(thread) = self.thread.take() {
            thread.join().map_err(|_| {
                StorageError::new(
                    StorageCode::SqliteThreadPanicked,
                    "BTCC checkpoint worker panicked",
                )
            })??;
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
    timing::wal_committed(pages);
    HOOK.with(|hook| {
        let mut hook = hook.borrow_mut();
        let Some(hook) = hook.as_mut() else { return };
        if pages < hook.last_pages {
            hook.next_pages = hook.pages;
        }
        hook.last_pages = pages;
        if pages < hook.next_pages {
            return;
        }
        // Accumulate a threshold of new frames instead of checkpointing every
        // commit while an earlier pass is catching up with a growing WAL.
        match hook.wake.try_send(()) {
            Ok(()) | Err(mpsc::TrySendError::Full(())) => {
                hook.next_pages = pages.saturating_add(hook.pages);
            }
            Err(mpsc::TrySendError::Disconnected(())) => {
                // A failed maintenance owner retains SQLite's stock behavior.
                // The owner-thread join still reports that failure on close.
                let _ = wal.checkpoint();
            }
        }
    });
    Ok(())
}

fn run(
    path: &std::path::Path,
    synchronous: i64,
    cache_size: i64,
    ready: &mpsc::SyncSender<StorageResult<()>>,
    requests: &mpsc::Receiver<()>,
) -> StorageResult<()> {
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
        let timing =
            crate::btcc::agent_loop::command_timing::CommandTiming::new("sqlite_checkpoint");
        let result = connection.execute_batch("PRAGMA wal_checkpoint(PASSIVE)");
        let synced = sqlite::sync_wal_index(&connection);
        // SQLite's automatic hook ignores checkpoint errors after COMMIT. Keep
        // that behavior; the next committed threshold crossing requests a pass.
        timing.mark(if result.is_ok() && synced.is_ok() {
            "background_passive_finished"
        } else {
            "background_passive_failed"
        });
    }
    connection
        .close()
        .map_err(|(_, error)| StorageError::sqlite(error))
}

fn open(
    path: &std::path::Path,
    synchronous: i64,
    cache_size: i64,
) -> StorageResult<sqlite::Connection> {
    let connection = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(StorageError::sqlite)?;
    connection
        .pragma_update(None, "synchronous", synchronous)
        .map_err(StorageError::sqlite)?;
    connection
        .pragma_update(None, "cache_size", cache_size)
        .map_err(StorageError::sqlite)?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
        .map_err(StorageError::sqlite)?;
    Ok(connection)
}
