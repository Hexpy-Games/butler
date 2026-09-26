//! Bounded serving-generation consumer of durable completion notices.

mod catchup;
mod process;

use parking_lot::Mutex;
use std::{path::PathBuf, sync::Arc, time::Instant};

use tokio::sync::{Semaphore, oneshot};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::{
    cognition::{
        CognitionEmbeddingPort, CognitionError, CognitionPathEnvironment,
        CognitionRegistrationService, CognitionResult, MemoryGenerationTarget,
    },
    coordination::{CognitionWriteCoordinator, ConsolidationLockState},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MemorySyncPoll {
    Idle,
    Processed,
    Deferred,
}

#[derive(Clone, Debug)]
pub(crate) struct MemoryCatchupOutcome {
    pub available: bool,
    pub scanned: usize,
    pub ingested: usize,
    pub wrapped: bool,
    pub outcome_cursor: Option<String>,
    pub recovered_message_cursor: Option<String>,
}

type Clock = Arc<dyn Fn() -> String + Send + Sync>;

pub(crate) struct NativeMemorySyncConsumer {
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
}

impl NativeMemorySyncConsumer {
    pub(crate) fn new(
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
        }
    }

    pub(crate) fn with_embedding(mut self, embedding: Arc<dyn CognitionEmbeddingPort>) -> Self {
        self.embedding = Some(embedding);
        self
    }

    pub(crate) fn with_rebuild_target(
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

    pub(crate) async fn poll_once(&self) -> CognitionResult<MemorySyncPoll> {
        let permit = self
            .admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| closed())?;
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
        receiver.await.map_err(|_| {
            CognitionError::new(
                "memory_sync_operation_failed",
                "memory_sync_operation_failed",
            )
        })?
    }

    /// Run the canonical catchup quantum through this consumer's serial permit.
    /// The process poll loop is deliberately not started by operator maintenance.
    pub(crate) async fn catchup_once(
        &self,
        cancellation: &CancellationToken,
    ) -> CognitionResult<MemoryCatchupOutcome> {
        let permit = self
            .admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| closed())?;
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
                    "memory_write_busy",
                    "memory_write_busy",
                )),
                Ok(false) => {
                    tokio::select! {
                        result = catchup::run_once(&input) => result,
                        () = cancellation.cancelled() => { operation.cancel(); Err(CognitionError::new("memory_operation_aborted", "memory_operation_aborted")) },
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
        receiver.await.map_err(|_| {
            CognitionError::new(
                "memory_sync_operation_failed",
                "memory_sync_operation_failed",
            )
        })?
    }

    pub(crate) async fn close(&self) {
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
    }
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
    CognitionError::new("memory_sync_closed", "memory_sync_closed")
}
