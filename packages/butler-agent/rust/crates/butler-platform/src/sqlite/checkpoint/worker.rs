//! Threshold passes and at most one idle finish per fully backfilled snapshot.
use super::*;
use rusqlite::{OpenFlags, config::DbConfig};

pub(super) fn run(
    path: &std::path::Path,
    synchronous: i64,
    cache_size: i64,
    ready: &mpsc::SyncSender<CheckpointResult<()>>,
    requests: &mpsc::Receiver<()>,
    maintenance: &Maintenance,
) -> CheckpointResult<()> {
    let connection = match open(path, synchronous, cache_size) {
        Ok(connection) => connection,
        Err(error) => {
            let _ = ready.send(Err(error));
            return Ok(());
        }
    };
    let _ = ready.send(Ok(()));
    while requests.recv().is_ok() {
        background_pass(&connection, maintenance);
        idle_finish(&connection, maintenance);
    }
    connection
        .close()
        .map_err(|(_, error)| CheckpointError::from(error))
}

fn background_pass(connection: &sqlite::Connection, maintenance: &Maintenance) {
    let started = Instant::now();
    let snapshot = {
        let mut progress = maintenance
            .progress
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // Coalesced wakes covered by a previous pass do no SQL work.
        if !progress.due(maintenance.pages) {
            return;
        }
        progress.attempted = progress.frames;
        (progress.generation, progress.frames)
    };
    if let Some(observer) = maintenance.observer {
        observer(CheckpointEvent::Started);
    }
    let guard = maintenance
        .checkpoint
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let result = backfill(connection);
    let (busy, log, backfilled) = result.as_ref().copied().unwrap_or((1, -1, -1));
    checkpointed(
        maintenance,
        "background",
        (log, backfilled),
        started.elapsed(),
        busy == 0,
    );
    if let Ok((0, log, backfilled)) = result.as_ref() {
        let mut progress = maintenance
            .progress
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        progress.completed(snapshot.0, *log, *backfilled);
        if progress.generation == snapshot.0 && *backfilled >= snapshot.1 {
            progress.finish_pending = true;
        }
    }
    drop(guard);
    finish_pass(connection, maintenance, started, result.is_ok());
}

fn idle_finish(connection: &sqlite::Connection, maintenance: &Maintenance) {
    let generation = {
        let mut progress = maintenance
            .progress
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !progress.finish_pending || !progress.lane_idle {
            return;
        }
        // Consume once, even when appends race this finish. Only a new fully
        // backfilled threshold pass may arm another finish.
        progress.finish_pending = false;
        if progress.frames <= progress.backfilled {
            return;
        }
        progress.generation
    };
    let started = Instant::now();
    let guard = maintenance
        .checkpoint
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let result = backfill(connection);
    #[cfg(feature = "test-support")]
    {
        let stall = maintenance
            .stall_finish
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(stall) = stall {
            stall();
        }
    }
    if let Ok((0, log, backfilled)) = result.as_ref() {
        maintenance
            .progress
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .completed(generation, *log, *backfilled);
    }
    drop(guard);
    let (busy, log, backfilled) = result.as_ref().copied().unwrap_or((1, -1, -1));
    checkpointed(
        maintenance,
        "finish",
        (log, backfilled),
        started.elapsed(),
        busy == 0,
    );
    finish_pass(connection, maintenance, started, result.is_ok());
}

fn backfill(connection: &sqlite::Connection) -> rusqlite::Result<(i32, i32, i32)> {
    connection.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })
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
