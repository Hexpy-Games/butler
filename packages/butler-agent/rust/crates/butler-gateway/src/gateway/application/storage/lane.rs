//! One short transaction per bounded drain; streaming is coalesced upstream.
use super::{AppStorageCode, AppStorageError, Completion, StorageResult, event_outbox};
use rusqlite::Connection;
use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

const BATCH_WINDOW: Duration = Duration::from_millis(2);
const BATCH_OPS: usize = 32;

type Run = Box<dyn FnOnce(&mut Connection, StorageResult<()>) -> Completion + Send>;
pub(super) struct Operation {
    pub(super) inspect: bool,
    pub(super) barrier: bool,
    pub(super) run: Run,
}

pub(super) fn run(
    db: &mut Connection,
    mut receiver: mpsc::Receiver<Operation>,
) -> StorageResult<()> {
    let mut opened = None;
    // Advance only after a successful sync, so a read-only batch retries failures.
    let mut synced_changes = db.total_changes();
    while let Some(first) = receiver.blocking_recv() {
        batch(db, first, &mut receiver, &mut opened, &mut synced_changes);
    }
    commit(db, &mut opened)?;
    sync(db, &mut synced_changes)
}

fn perform(
    db: &mut Connection,
    operation: Operation,
    admission: StorageResult<()>,
    completions: &mut Vec<Completion>,
) {
    let snapshot = event_outbox::snapshot();
    let exclusive = operation.barrier;
    let result = catch_unwind(AssertUnwindSafe(|| (operation.run)(db, admission)));
    match result {
        Ok(completion) => completions.push(completion),
        Err(payload) => {
            super::super::panic_isolation::report("app-sqlite", payload.as_ref());
            event_outbox::restore(snapshot);
            if !db.is_autocommit() {
                let rollback = if exclusive {
                    "ROLLBACK"
                } else {
                    "ROLLBACK TO app_operation; RELEASE app_operation"
                };
                let _ = db.execute_batch(rollback);
            }
        }
    }
}

fn commit(db: &Connection, opened: &mut Option<Instant>) -> StorageResult<()> {
    let timing = crate::gateway::command_timing::CommandTiming::new("app_sqlite_commit");
    if opened.take().is_some() && !db.is_autocommit() {
        let (_, committed) = event_outbox::snapshot();
        if let Err(error) = db.execute_batch("COMMIT") {
            // A commit hook can run before SQLite discovers a commit failure.
            event_outbox::restore((0, committed));
            return Err(AppStorageError::sqlite(error));
        }
    }
    timing.mark("sqlite_done");
    event_outbox::flush();
    timing.mark("events_delivered");
    Ok(())
}

fn sync(db: &Connection, synced_changes: &mut u64) -> StorageResult<()> {
    if db.total_changes() == *synced_changes {
        return Ok(());
    }
    let timing = crate::gateway::command_timing::CommandTiming::new("app_sqlite_wal_sync");
    butler_platform::sqlite::sync_wal_index(db).map_err(|error| {
        let error = AppStorageError::new(AppStorageCode::AppSqliteWalSyncFailed, error.to_string())
            .with_source(error);
        butler_core::diagnostic!(
            "[app-sqlite] committed; WAL index sync failed: {}: {}",
            error.code(),
            error.message()
        );
        error
    })?;
    *synced_changes = db.total_changes();
    timing.mark("synced");
    Ok(())
}

fn complete(completions: &mut Vec<Completion>, result: &StorageResult<()>) {
    for completion in completions.drain(..) {
        completion(result.clone());
    }
}

fn batch(
    db: &mut Connection,
    first: Operation,
    receiver: &mut mpsc::Receiver<Operation>,
    opened: &mut Option<Instant>,
    synced_changes: &mut u64,
) {
    let mut completions = Vec::new();
    let result = drain(
        db,
        first,
        receiver,
        opened,
        synced_changes,
        &mut completions,
    )
    .and_then(|()| commit(db, opened));
    if let Err(error) = &result {
        // COMMIT may leave the transaction open (for example, deferred FKs).
        // Report this batch's failure without abandoning subsequent requests.
        *opened = None;
        let rollback = if db.is_autocommit() {
            Ok(())
        } else {
            db.execute_batch("ROLLBACK")
        };
        event_outbox::flush();
        if error.code() != AppStorageCode::AppSqliteWalSyncFailed.as_str() {
            butler_core::diagnostic!(
                "[app-sqlite] batch failed: {}: {}; rollback={rollback:?}",
                error.code(),
                error.message()
            );
        }
    }
    let result = result.and_then(|()| sync(db, synced_changes));
    complete(&mut completions, &result);
}

fn drain(
    db: &mut Connection,
    first: Operation,
    receiver: &mut mpsc::Receiver<Operation>,
    opened: &mut Option<Instant>,
    synced_changes: &mut u64,
    completions: &mut Vec<Completion>,
) -> StorageResult<()> {
    let started = Instant::now();
    let mut next = Some(first);
    for index in 0..BATCH_OPS {
        let Some(operation) = next.take() else { break };
        if operation.barrier {
            if let Err(error) = commit(db, opened).and_then(|()| sync(db, synced_changes)) {
                perform(db, operation, Err(error.clone()), completions);
                return Err(error);
            }
            complete(completions, &Ok(()));
        }
        let barrier = operation.barrier;
        if operation.inspect || super::metrics::baseline() {
            perform(db, operation, Ok(()), completions);
            if super::metrics::baseline() {
                event_outbox::flush();
            }
        } else {
            if opened.is_none() {
                if let Err(error) = db.execute_batch("BEGIN IMMEDIATE") {
                    let error = AppStorageError::sqlite(error);
                    perform(db, operation, Err(error), completions);
                    return Ok(());
                }
                *opened = Some(Instant::now());
            }
            perform(db, operation, Ok(()), completions);
        }
        if barrier {
            let synced = sync(db, synced_changes);
            event_outbox::flush();
            complete(completions, &synced);
        }
        if index + 1 == BATCH_OPS || started.elapsed() >= BATCH_WINDOW || super::metrics::baseline()
        {
            break;
        }
        next = receiver.try_recv().ok();
    }
    Ok(())
}
