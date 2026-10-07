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
    while let Some(first) = receiver.blocking_recv() {
        batch(db, first, &mut receiver, &mut opened)?;
    }
    commit(db, &mut opened)
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
    if opened.take().is_some() && !db.is_autocommit() {
        db.execute_batch("COMMIT")
            .map_err(AppStorageError::sqlite)?;
    }
    event_outbox::flush();
    Ok(())
}

fn batch(
    db: &mut Connection,
    first: Operation,
    receiver: &mut mpsc::Receiver<Operation>,
    opened: &mut Option<Instant>,
) -> StorageResult<()> {
    let started = Instant::now();
    let before = db.total_changes();
    let mut completions = Vec::new();
    let mut next = Some(first);
    for index in 0..BATCH_OPS {
        let Some(operation) = next.take() else { break };
        if operation.barrier {
            commit(db, opened)?;
        }
        if operation.inspect || super::metrics::baseline() {
            perform(db, operation, Ok(()), &mut completions);
            if super::metrics::baseline() {
                event_outbox::flush();
            }
        } else {
            if opened.is_none() {
                if let Err(error) = db.execute_batch("BEGIN IMMEDIATE") {
                    perform(
                        db,
                        operation,
                        Err(AppStorageError::sqlite(error)),
                        &mut completions,
                    );
                    break;
                }
                *opened = Some(Instant::now());
            }
            perform(db, operation, Ok(()), &mut completions);
        }
        if index + 1 == BATCH_OPS || started.elapsed() >= BATCH_WINDOW || super::metrics::baseline()
        {
            break;
        }
        next = receiver.try_recv().ok();
    }
    let result = commit(db, opened).and_then(|()| {
        if db.total_changes() == before {
            return Ok(());
        }
        butler_platform::sqlite::sync_wal_index(db).map_err(|error| {
            AppStorageError::new(AppStorageCode::AppSqliteWalSyncFailed, error.to_string())
                .with_source(error)
        })
    });
    for completion in completions {
        completion(result.clone());
    }
    result
}
