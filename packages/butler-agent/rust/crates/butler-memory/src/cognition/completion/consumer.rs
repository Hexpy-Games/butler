//! Bounded serving-generation consumer of durable completion notices.

mod catchup;
mod probe;
mod process;
use super::wake;

use parking_lot::Mutex;
use std::{
    path::PathBuf,
    sync::Arc,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

use tokio::sync::{Semaphore, oneshot};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::cognition::CognitionCode;
use crate::{
    cognition::{
        CognitionEmbeddingPort, CognitionError, CognitionPathEnvironment,
        CognitionRegistrationService, CognitionResult, MemoryGenerationTarget,
    },
    coordination::{CognitionWriteCoordinator, ConsolidationLockState},
};

/// What one poll of the memory sync queue did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemorySyncPoll {
    /// Nothing was waiting.
    Idle,
    /// One queue entry or projection step was processed.
    Processed,
    /// Work is waiting but cannot run yet.
    Deferred,
}

#[derive(Clone, Debug)]
pub struct MemoryCatchupOutcome {
    pub available: bool,
    pub scanned: usize,
    pub ingested: usize,
    pub wrapped: bool,
    pub outcome_cursor: Option<String>,
    pub recovered_message_cursor: Option<String>,
}

type Clock = Arc<dyn Fn() -> String + Send + Sync>;

/// Consumes the memory sync queue: registers completed turns and typed sources, projects them and
/// embeds their vectors.
pub struct MemorySyncConsumer {
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    registration: Arc<CognitionRegistrationService>,
    embedding: Option<Arc<dyn CognitionEmbeddingPort>>,
    target: Option<MemoryGenerationTarget>,
    coordinator: Arc<CognitionWriteCoordinator>,
    clock: Clock,
    admission: Arc<Semaphore>,
    tasks: TaskTracker,
    shutdown: CancellationToken,
    closing: Mutex<bool>,
    catchup_at: Arc<Mutex<Option<Instant>>>,
    unclean_start: Arc<AtomicBool>,
    catchup_progress: Arc<Mutex<Option<(PathBuf, crate::cognition::graph::CatchupState)>>>,
    probe: Arc<probe::ProbeReader>,
}

impl MemorySyncConsumer {
    /// A consumer over `data_root`.
    pub fn new(
        data_root: PathBuf,
        environment: CognitionPathEnvironment,
        registration: Arc<CognitionRegistrationService>,
        coordinator: Arc<CognitionWriteCoordinator>,
        clock: Clock,
    ) -> Self {
        Self {
            data_root,
            environment,
            registration,
            embedding: None,
            target: None,
            coordinator,
            clock,
            admission: Arc::new(Semaphore::new(1)),
            tasks: TaskTracker::new(),
            shutdown: CancellationToken::new(),
            closing: Mutex::new(false),
            catchup_at: Arc::new(Mutex::new(None)),
            unclean_start: Arc::new(AtomicBool::new(false)),
            catchup_progress: Arc::new(Mutex::new(None)),
            probe: Arc::new(probe::ProbeReader::default()),
        }
    }

    /// Also embeds projected vector units with `embedding`.
    pub fn with_embedding(mut self, embedding: Arc<dyn CognitionEmbeddingPort>) -> Self {
        self.embedding = Some(embedding);
        self
    }

    /// Reconcile the entire canonical inventory once after an unclean service exit.
    pub fn with_unclean_start(mut self, unclean: bool) -> Self {
        self.unclean_start = Arc::new(AtomicBool::new(unclean));
        self
    }

    /// Consumes into a rebuild candidate instead of the active generation.
    pub fn with_rebuild_target(
        mut self,
        generation_id: String,
        canonical_snapshot_id: String,
    ) -> Self {
        self.target = Some(MemoryGenerationTarget::Rebuild {
            generation_id,
            canonical_snapshot_id,
        });
        self
    }

    /// Processes the next queue entry or projection step.
    pub async fn poll_once(&self) -> CognitionResult<MemorySyncPoll> {
        let permit = self
            .admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|source| closed().with_source(source))?;
        let token = {
            let closing = self.closing.lock();
            if *closing {
                return Err(closed());
            }
            self.tasks.token()
        };
        let input = process::Input {
            data_root: self.data_root.clone(),
            environment: self.environment.clone(),
            registration: self.registration.clone(),
            embedding: self.embedding.clone(),
            target: self.target.clone(),
            coordinator: self.coordinator.clone(),
            clock: self.clock.clone(),
            catchup_at: self.catchup_at.clone(),
            unclean_start: self.unclean_start.clone(),
            catchup_progress: self.catchup_progress.clone(),
            probe: self.probe.clone(),
            shutdown: self.shutdown.clone(),
        };
        let (sender, receiver) = oneshot::channel();
        // Detached on purpose: the operation token/guard moved into the task keeps the
        // owner's close waiting for it, and the result returns through the oneshot,
        // so a cancelled caller cannot abandon the operation midway.
        tokio::spawn(async move {
            let _token = token;
            let _permit = permit;
            let _ = sender.send(process::poll(input).await);
        });
        receiver.await.map_err(|source| {
            CognitionError::new(
                CognitionCode::MemorySyncOperationFailed,
                "memory_sync_operation_failed",
            )
            .with_source(source)
        })?
    }

    /// Run the canonical catchup quantum through this consumer's serial permit.
    /// The process poll loop is deliberately not started by operator maintenance.
    pub async fn catchup_once(
        &self,
        cancellation: &CancellationToken,
    ) -> CognitionResult<MemoryCatchupOutcome> {
        let permit = self
            .admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|source| closed().with_source(source))?;
        let token = {
            let closing = self.closing.lock();
            if *closing || cancellation.is_cancelled() {
                return Err(closed());
            }
            self.tasks.token()
        };
        let operation = self.shutdown.child_token();
        let input = process::Input {
            data_root: self.data_root.clone(),
            environment: self.environment.clone(),
            registration: self.registration.clone(),
            embedding: self.embedding.clone(),
            target: self.target.clone(),
            coordinator: self.coordinator.clone(),
            clock: self.clock.clone(),
            catchup_at: self.catchup_at.clone(),
            unclean_start: self.unclean_start.clone(),
            catchup_progress: self.catchup_progress.clone(),
            probe: self.probe.clone(),
            shutdown: operation.clone(),
        };
        let (sender, receiver) = oneshot::channel();
        let cancellation = cancellation.clone();
        // Detached on purpose: the operation token/guard moved into the task keeps the
        // owner's close waiting for it, and the result returns through the oneshot,
        // so a cancelled caller cannot abandon the operation midway.
        tokio::spawn(async move {
            let _token = token;
            let _permit = permit;
            let result = match paused(&input) {
                Err(error) => Err(error),
                Ok(true) => Err(CognitionError::new(
                    CognitionCode::MemoryWriteBusy,
                    "memory_write_busy",
                )),
                Ok(false) => {
                    tokio::select! {
                        result = catchup::run_once(&input) => result,
                        () = cancellation.cancelled() => { operation.cancel(); Err(CognitionError::new(CognitionCode::MemoryOperationAborted, "memory_operation_aborted")) },
                    }
                }
            };
            let _ = sender.send(result.map(|report| MemoryCatchupOutcome {
                available: report.available,
                scanned: report.scanned,
                ingested: report.ingested,
                wrapped: report.wrapped,
                outcome_cursor: report.outcome_cursor,
                recovered_message_cursor: report.recovered_message_cursor,
            }));
        });
        receiver.await.map_err(|source| {
            CognitionError::new(
                CognitionCode::MemorySyncOperationFailed,
                "memory_sync_operation_failed",
            )
            .with_source(source)
        })?
    }

    /// Stops admitting polls and waits for running ones.
    pub async fn close(&self) {
        {
            let mut closing = self.closing.lock();
            if !*closing {
                *closing = true;
                self.admission.close();
                self.tasks.close();
                self.shutdown.cancel();
            }
        }
        self.tasks.wait().await;
        self.probe.close();
    }

    /// Sleeps up to `delay`, ending early when in-process work is signalled,
    /// the queue changes (another process appended to it), or the consumer
    /// closes. An idle loop calls this instead of polling on a short timer.
    /// Returns whether something woke it before `delay` elapsed.
    pub async fn wait_for_work(&self, delay: Duration) -> bool {
        let memory_root = self.environment.memory_root(&self.data_root);
        let queue = queue_length(&memory_root);
        let deadline = Instant::now() + delay;
        loop {
            let slice = deadline
                .saturating_duration_since(Instant::now())
                .min(QUEUE_WATCH_INTERVAL);
            if slice.is_zero() {
                return false;
            }
            tokio::select! {
                () = self.shutdown.cancelled() => return true,
                () = wake::memory_work_signalled() => return true,
                () = tokio::time::sleep(slice) => {}
            }
            if queue_length(&memory_root) != queue {
                return true;
            }
        }
    }
}

/// How often a long idle sleep looks at the queue file for appends made by
/// another process. A metadata read, no database.
const QUEUE_WATCH_INTERVAL: Duration = Duration::from_secs(2);

fn queue_length(memory_root: &std::path::Path) -> u64 {
    std::fs::metadata(memory_root.join("queue/sync.jsonl")).map_or(0, |meta| meta.len())
}

fn paused(input: &process::Input) -> CognitionResult<bool> {
    let lock = input.environment.consolidation_lock(&input.data_root);
    let state = input
        .coordinator
        .inspect(&lock)
        .map_err(CognitionError::from)?
        .state;
    Ok(matches!(
        state,
        ConsolidationLockState::Held
            | ConsolidationLockState::Busy
            | ConsolidationLockState::LegacyBlocked
            | ConsolidationLockState::Unavailable
    ))
}

fn closed() -> CognitionError {
    CognitionError::new(CognitionCode::MemorySyncClosed, "memory_sync_closed")
}
