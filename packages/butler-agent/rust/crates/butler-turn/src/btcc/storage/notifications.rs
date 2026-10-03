//! Lane activity observation and change-driven publication wakeup.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

thread_local! {
    static SQL_COUNTER: std::cell::RefCell<Option<Arc<AtomicU64>>> = const { std::cell::RefCell::new(None) };
}

fn observe_statements(connection: &Connection, counter: &Arc<AtomicU64>) {
    SQL_COUNTER.with(|current| {
        let mut current = current.borrow_mut();
        if current
            .as_ref()
            .is_none_or(|old| !Arc::ptr_eq(old, counter))
        {
            *current = Some(counter.clone());
            connection.trace_v2(
                rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
                Some(count_statement),
            );
        }
    });
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "SQLite's callback signature owns its trace event"
)]
fn count_statement(event: rusqlite::trace::TraceEvent<'_>) {
    // Count execution without expanding, retaining or logging SQL parameter values.
    if matches!(event, rusqlite::trace::TraceEvent::Stmt(..)) {
        SQL_COUNTER.with(|current| {
            if let Some(counter) = current.borrow().as_ref() {
                counter.fetch_add(1, Ordering::Relaxed);
            }
        });
    }
}

impl BtccStorage {
    pub fn work_model_changes(&self) -> Arc<tokio::sync::Notify> {
        self.inner.work_model_changed.clone()
    }
    /// Coalesced wake after a lane operation changed SQLite state.
    pub fn changes(&self) -> Arc<tokio::sync::Notify> {
        self.inner.changed.clone()
    }

    /// Memory-only observation of lane operations, including reads.
    pub fn operation_count(&self) -> u64 {
        self.inner
            .operations
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Executed BTCC SQL statements when core instrumentation is enabled.
    pub fn sql_statement_count(&self) -> u64 {
        self.inner.sql_statements.load(Ordering::Relaxed)
    }

    pub(super) fn observed_job<T, F>(
        &self,
        operation: F,
        completion: oneshot::Sender<StorageResult<T>>,
    ) -> DatabaseOperation
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection, &RuntimeOwner) -> StorageResult<T> + Send + 'static,
    {
        let inner = self.inner.clone();
        Box::new(move |connection, owner| {
            if std::env::var("BUTLER_WORK_MODEL").as_deref() == Ok("core") {
                observe_statements(connection, &inner.sql_statements);
            }
            inner
                .operations
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let before = connection.total_changes();
            let result = operation(connection, owner);
            if connection.total_changes() != before {
                inner.changed.notify_one();
                inner.work_model_changed.notify_one();
            }
            let _cancelled_caller = completion.send(result);
        })
    }
}
