//! A lane operation owns its result until the enclosing batch commits.
use super::{
    AppStorageError, Completion, StorageResult, event_outbox,
    lane::Operation,
    metrics::{self, Metrics},
};
use rusqlite::Connection;
use std::{sync::Arc, time::Instant};
use tokio::sync::oneshot;

pub(super) fn job<T, F>(
    operation: F,
    completion: oneshot::Sender<StorageResult<T>>,
    metrics: Arc<Metrics>,
    inspect: bool,
    barrier: bool,
) -> Operation
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> StorageResult<T> + Send + 'static,
{
    let started = Instant::now();
    Operation {
        inspect,
        barrier,
        run: Box::new(move |connection, admission| {
            let admitted = Instant::now();
            if !inspect {
                metrics.write_phase("queue", started.elapsed());
            }
            let result = admission.and_then(|()| {
                if inspect {
                    operation(connection)
                } else {
                    apply(connection, operation, &metrics)
                }
            });
            if !inspect {
                metrics.write_phase("sql", admitted.elapsed());
            }
            let ready = Instant::now();
            let complete: Completion = Box::new(move |commit| {
                let result = result.and_then(|value| commit.map(|()| value));
                if !inspect {
                    metrics.write_phase("commit_wait", ready.elapsed());
                    metrics.operation(started.elapsed());
                }
                if result.as_ref().is_err_and(AppStorageError::is_busy) {
                    metrics.busy();
                }
                let _cancelled_observer = completion.send(result);
            });
            complete
        }),
    }
}
fn apply<T>(
    db: &mut Connection,
    operation: impl FnOnce(&mut Connection) -> StorageResult<T>,
    metrics: &Metrics,
) -> StorageResult<T> {
    let baseline = metrics::baseline();
    let snapshot = event_outbox::snapshot();
    if !baseline {
        db.execute_batch("SAVEPOINT app_operation")
            .map_err(AppStorageError::sqlite)?;
    }
    let started = Instant::now();
    let refreshed = super::super::monitoring::materialized::refresh(db);
    metrics.write_phase("monitor_before", started.elapsed());
    let started = Instant::now();
    let result = refreshed.and_then(|()| operation(db));
    metrics.write_phase("operation", started.elapsed());
    let started = Instant::now();
    let result = result
        .and_then(|value| super::super::monitoring::materialized::refresh(db).map(|()| value));
    metrics.write_phase("monitor_after", started.elapsed());
    if !baseline {
        if result.is_ok() {
            db.execute_batch("RELEASE app_operation")
                .map_err(AppStorageError::sqlite)?;
        } else {
            db.execute_batch("ROLLBACK TO app_operation; RELEASE app_operation")
                .map_err(AppStorageError::sqlite)?;
            event_outbox::restore(snapshot);
        }
    }
    result
}
