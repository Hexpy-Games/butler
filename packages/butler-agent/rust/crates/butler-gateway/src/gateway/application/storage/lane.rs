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
const IDLE_RETENTION: Duration = Duration::from_secs(10);

type Run = Box<dyn FnOnce(StorageResult<&mut Connection>) -> Completion + Send>;
pub(super) struct Operation {
    pub(super) inspect: bool,
    pub(super) barrier: bool,
    pub(super) run: Run,
}

pub(super) fn run(
    db: &mut Connection,
    receiver: &mut mpsc::Receiver<Operation>,
    mut first: Option<Operation>,
) -> StorageResult<()> {
    let mut opened = None;
    loop {
        let operation = first.take().or_else(|| receive(receiver, IDLE_RETENTION));
        let Some(operation) = operation else { break };
        batch(db, operation, receiver, &mut opened)?;
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
    let result = catch_unwind(AssertUnwindSafe(|| {
        (operation.run)(admission.map(|()| &mut *db))
    }));
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
        db.execute_batch("COMMIT")
            .map_err(AppStorageError::sqlite)?;
    }
    timing.mark("sqlite_done");
    event_outbox::flush();
    timing.mark("events_delivered");
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

impl Operation {
    pub(super) fn fail(self, error: AppStorageError) {
        (self.run)(Err(error))(Ok(()));
    }
}

/// Poll registers the wake before parking; unpark retains a token even when
/// admission races the park. No runtime or periodic polling is needed.
fn receive(receiver: &mut mpsc::Receiver<Operation>, timeout: Duration) -> Option<Operation> {
    struct Wake(std::thread::Thread);
    impl std::task::Wake for Wake {
        fn wake(self: std::sync::Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = std::task::Waker::from(std::sync::Arc::new(Wake(std::thread::current())));
    let mut context = std::task::Context::from_waker(&waker);
    let deadline = Instant::now() + timeout;
    loop {
        if let std::task::Poll::Ready(operation) = receiver.poll_recv(&mut context) {
            return operation;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        std::thread::park_timeout(remaining);
    }
}
