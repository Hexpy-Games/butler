//! Two owned WAL readers; fresh transactions never run on Tokio workers.
use super::{AppStorageError, StorageResult};
use parking_lot::{Condvar, Mutex};
use rusqlite::{Connection, OpenFlags};
use std::{
    collections::VecDeque,
    path::Path,
    sync::Arc,
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const CONNECTIONS: usize = 2;
const SPARE_RETENTION: Duration = Duration::from_secs(10);
type ReadOperation = Box<dyn FnOnce(&Connection) -> StorageResult<()> + Send>;

struct Job {
    operation: ReadOperation,
    completed: tokio::sync::oneshot::Sender<StorageResult<()>>,
    permit: OwnedSemaphorePermit,
    guard: tokio::sync::OwnedRwLockReadGuard<()>,
}
#[derive(Default)]
struct Queue {
    jobs: VecDeque<Job>,
    stopped: bool,
}
#[derive(Default)]
struct WorkQueue {
    state: Mutex<Queue>,
    changed: Condvar,
    #[cfg(test)]
    cached_readers: std::sync::atomic::AtomicUsize,
}
enum Work {
    Read(Job),
    Retire,
    Stop,
}
impl WorkQueue {
    fn reader_opened(&self) {
        #[cfg(test)]
        {
            self.cached_readers
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        }
    }
    fn reader_closed(&self) {
        #[cfg(test)]
        {
            self.cached_readers
                .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
        }
    }
    fn next(&self, retire_at: Option<Instant>) -> Work {
        let mut state = self.state.lock();
        loop {
            if let Some(job) = state.jobs.pop_front() {
                return Work::Read(job);
            }
            if state.stopped {
                return Work::Stop;
            }
            match retire_at {
                Some(deadline) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Work::Retire;
                    }
                    self.changed.wait_for(&mut state, remaining);
                }
                None => self.changed.wait(&mut state),
            }
        }
    }
    fn stop(&self) {
        self.state.lock().stopped = true;
        self.changed.notify_all();
    }
}

pub(super) struct ReadPool {
    work: Arc<WorkQueue>,
    workers: Mutex<Vec<JoinHandle<()>>>,
    permits: Arc<Semaphore>,
    gate: Arc<tokio::sync::RwLock<()>>,
}
impl ReadPool {
    pub(super) fn open(path: &Path) -> StorageResult<Self> {
        // Validate one reader now; the spare opens only when it receives work.
        let mut first = Some(Self::connection(path)?);
        let work = Arc::new(WorkQueue::default());
        work.reader_opened();
        let mut workers: Vec<JoinHandle<()>> = Vec::with_capacity(CONNECTIONS);
        for slot in 0..CONNECTIONS {
            let queue = work.clone();
            let path = path.to_owned();
            let reader = first.take();
            match std::thread::Builder::new()
                .name(format!("app-sqlite-reader-{slot}"))
                .spawn(move || Self::run_worker(&path, &queue, reader))
            {
                Ok(worker) => workers.push(worker),
                Err(error) => {
                    work.stop();
                    for worker in workers {
                        let _joined = worker.join();
                    }
                    return Err(AppStorageError::new(
                        super::AppStorageCode::AppSqliteJoinFailed,
                        error.to_string(),
                    ));
                }
            }
        }
        Ok(Self {
            work,
            workers: Mutex::new(workers),
            permits: Arc::new(Semaphore::new(CONNECTIONS)),
            gate: Arc::default(),
        })
    }
    fn connection(path: &Path) -> StorageResult<butler_platform::sqlite::Connection> {
        let connection =
            butler_platform::sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(AppStorageError::sqlite)?;
        super::tuning::configure_read(&connection)?;
        Ok(connection)
    }
    pub(super) fn read<T, F>(
        self: &Arc<Self>,
        operation: F,
    ) -> impl std::future::Future<Output = StorageResult<T>> + Send + '_
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> StorageResult<T> + Send + 'static,
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let operation: ReadOperation = Box::new(move |db| {
            let value = operation(db)?;
            let _sent = sender.send(value);
            Ok(())
        });
        self.complete(operation, receiver)
    }
    async fn complete<T: Send + 'static>(
        self: &Arc<Self>,
        operation: ReadOperation,
        receiver: tokio::sync::oneshot::Receiver<T>,
    ) -> StorageResult<T> {
        self.dispatch(operation).await?;
        receiver.await.map_err(|error| {
            AppStorageError::new(
                super::AppStorageCode::AppSqliteJoinFailed,
                error.to_string(),
            )
        })
    }
    async fn dispatch(self: &Arc<Self>, operation: ReadOperation) -> StorageResult<()> {
        let guard = self.gate.clone().read_owned().await;
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| {
                AppStorageError::new(
                    super::AppStorageCode::AppSqliteOwnerClosed,
                    error.to_string(),
                )
            })?;
        let (completed, completion) = tokio::sync::oneshot::channel();
        self.work.state.lock().jobs.push_back(Job {
            operation,
            completed,
            permit,
            guard,
        });
        self.work.changed.notify_one();
        completion.await.map_err(|error| {
            AppStorageError::new(
                super::AppStorageCode::AppSqliteJoinFailed,
                error.to_string(),
            )
        })?
    }
    fn run_worker(
        path: &Path,
        work: &WorkQueue,
        mut connection: Option<butler_platform::sqlite::Connection>,
    ) {
        let mut last_used = Instant::now();
        loop {
            let deadline = connection.as_ref().map(|_| last_used + SPARE_RETENTION);
            match work.next(deadline) {
                Work::Stop => {
                    if connection.take().is_some() {
                        work.reader_closed();
                    }
                    return;
                }
                Work::Retire => {
                    connection = None;
                    work.reader_closed();
                }
                Work::Read(Job {
                    operation,
                    completed,
                    permit,
                    guard,
                }) => {
                    let result = Self::run_read(path, work, &mut connection, operation);
                    last_used = Instant::now();
                    // Admission belongs to the queued job even if its caller
                    // disappears. Close waits for all transactions to finish.
                    drop(permit);
                    drop(guard);
                    let _completed = completed.send(result);
                }
            }
        }
    }
    fn run_read(
        path: &Path,
        work: &WorkQueue,
        connection: &mut Option<butler_platform::sqlite::Connection>,
        operation: ReadOperation,
    ) -> StorageResult<()> {
        if connection.is_none() {
            *connection = Some(Self::connection(path)?);
            work.reader_opened();
        }
        let Some(connection) = connection.as_ref() else {
            return Err(AppStorageError::new(
                super::AppStorageCode::AppSqliteOwnerClosed,
                "Reader unavailable",
            ));
        };
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Every request still starts a fresh WAL snapshot. Reuse only the
            // owned thread/descriptor, never a transaction or response value.
            let transaction = connection
                .unchecked_transaction()
                .map_err(AppStorageError::sqlite)?;
            operation(&transaction)?;
            transaction.commit().map_err(AppStorageError::sqlite)?;
            butler_platform::sqlite::sync_wal_index(connection).map_err(|error| {
                AppStorageError::new(
                    super::AppStorageCode::AppSqliteWalSyncFailed,
                    error.to_string(),
                )
                .with_source(error)
            })
        }))
        .unwrap_or_else(|payload| {
            let message = payload
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| payload.downcast_ref::<&str>().copied())
                .unwrap_or("unknown panic");
            Err(AppStorageError::new(
                super::AppStorageCode::AppSqliteJoinFailed,
                format!("SQLite reader panicked: {message}"),
            ))
        })
    }
    pub(super) async fn close(self: &Arc<Self>) {
        let _guard = self.gate.write().await;
        self.permits.close();
        let pool = self.clone();
        let _closed = tokio::task::spawn_blocking(move || {
            pool.work.stop();
            for worker in pool.workers.lock().drain(..) {
                let _joined = worker.join();
            }
        })
        .await;
    }
}
impl Drop for ReadPool {
    fn drop(&mut self) {
        self.work.stop();
    }
}
