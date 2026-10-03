//! Bounded serving-generation consumer of durable completion notices.

mod blocking;
mod catchup;
mod feedback;
mod probe;
mod process;
mod vector_schedule;
use super::wake;
pub use vector_schedule::{VECTOR_BACKLOG_CAP, VECTOR_MAX_AGE_HOURS};

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
    instruction_owner: crate::cognition::RememberedRuleOwner,
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
    vector_batch: Arc<AtomicBool>,
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
        let publisher = Arc::new(crate::cognition::CompletionPublisher::new(
            &data_root,
            &environment,
            clock.clone(),
        ));
        let instruction_owner = crate::cognition::RememberedRuleOwner::new(
            data_root.clone(),
            environment.clone(),
            coordinator.clone(),
            publisher,
        );
        Self {
            instruction_owner,
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
            vector_batch: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Use the runtime's configured instruction owner for every capture drain.
    pub fn with_instruction_owner(mut self, owner: crate::cognition::RememberedRuleOwner) -> Self {
        self.instruction_owner = owner;
        self
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
        self.poll_with(false, self.shutdown.clone()).await
    }

    /// Fully drain eligible vectors during the daily maintenance window, yielding
    /// between quanta. Cancellation reaches the lease and embedding request.
    pub async fn drain_vectors(&self, cancellation: &CancellationToken) -> CognitionResult<()> {
        loop {
            if cancellation.is_cancelled() {
                return Err(closed());
            }
            match self.poll_with(true, cancellation.clone()).await? {
                MemorySyncPoll::Processed => tokio::task::yield_now().await,
                MemorySyncPoll::Idle => return Ok(()),
                MemorySyncPoll::Deferred => {
                    return Err(CognitionError::new(
                        CognitionCode::MemoryWriteBusy,
                        "memory_write_busy",
                    ));
                }
            }
        }
    }

    async fn poll_with(
        &self,
        daily_batch: bool,
        cancellation: CancellationToken,
    ) -> CognitionResult<MemorySyncPoll> {
        let permit = tokio::select! {
            permit = self.admission.clone().acquire_owned() => permit.map_err(|source| closed().with_source(source))?,
            () = cancellation.cancelled() => return Err(closed()),
        };
        let token = {
            let closing = self.closing.lock();
            if *closing {
                return Err(closed());
            }
            self.tasks.token()
        };
        let operation = self.shutdown.child_token();
        let input = process::Input {
            instruction_owner: self.instruction_owner.clone(),
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
            vector_batch: self.vector_batch.clone(),
            daily_batch,
            shutdown: operation.clone(),
        };
        let (sender, receiver) = oneshot::channel();
        // Detached on purpose: the operation token/guard moved into the task keeps the
        // owner's close waiting for it, and the result returns through the oneshot,
        // so a cancelled caller cannot abandon the operation midway.
        tokio::spawn(async move {
            let _token = token;
            let _permit = permit;
            let poll = async {
                match feedback::drain(&input).await {
                    Ok(Some(result)) => Ok(result),
                    Ok(None) => process::poll(input).await,
                    Err(error) => Err(error),
                }
            };
            tokio::pin!(poll);
            let result = tokio::select! {
                result = &mut poll => result,
                () = cancellation.cancelled() => { operation.cancel(); poll.await },
            };
            let _ = sender.send(result);
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
            instruction_owner: self.instruction_owner.clone(),
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
            vector_batch: self.vector_batch.clone(),
            daily_batch: false,
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
            let owned = input.clone();
            let result = match blocking::run(move || paused(&owned)).await {
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
        if let Err(error) = self.probe.close().await {
            butler_core::diagnostic!("[memory-sync-close] {}", error.code());
        }
    }

    /// Bounds the backoff after a successful idle poll by the next catch-up.
    /// Call only after polling an available generation: deferred work and absent
    /// generations must keep their backoff even when catch-up is overdue.
    pub fn idle_delay(&self, backoff: Duration) -> Duration {
        self.catchup_at.lock().map_or(backoff, |last| {
            backoff.min(catchup::INTERVAL.saturating_sub(last.elapsed()))
        })
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
