//! Process-owned completion consumer. Queue and semantic work run independently
//! of interactive Turns, using the same model and writer-coordination owners.

use parking_lot::Mutex;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::host::EmbeddingOwner;
use butler_memory::cognition::GenerationVectorAdapter;
use butler_memory::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionRegistrationService,
};
use butler_memory::cognition::{MemorySyncConsumer, MemorySyncPoll};
use butler_memory::cognition::{active_memory_descriptor_exists, resolve_active_generation};
use butler_memory::coordination::CognitionWriteCoordinator;
use butler_models::models::{ModelConfigurationClock, ModelProvider};
use butler_turn::btcc::BtccError;

use crate::host::SystemIdentity;

pub(in crate::host) struct MemorySync {
    consumer: Arc<MemorySyncConsumer>,
    registration: Arc<CognitionRegistrationService>,
    shutdown: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl MemorySync {
    pub(in crate::host) fn consumer(&self) -> Arc<MemorySyncConsumer> {
        self.consumer.clone()
    }

    pub(in crate::host) fn open(
        data_root: &Path,
        paths: &CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
        provider: Arc<ModelProvider>,
        unclean_previous_exit: bool,
        embedding: Arc<EmbeddingOwner>,
        vector: Arc<GenerationVectorAdapter>,
    ) -> Result<Self, BtccError> {
        let clock: Arc<dyn Fn() -> String + Send + Sync> = Arc::new(|| SystemIdentity.now_iso());
        if active_memory_descriptor_exists(data_root, paths).map_err(error)? {
            resolve_active_generation(data_root, paths).map_err(error)?;
        }
        let registration = Arc::new(CognitionRegistrationService::with_projection(
            paths.clone(),
            coordinator.clone(),
            clock.clone(),
            provider,
            vector,
            Arc::new(SystemIdentity),
        ));
        let consumer = MemorySyncConsumer::new(
            data_root.to_path_buf(),
            paths.clone(),
            registration.clone(),
            coordinator,
            clock,
        )
        .with_unclean_start(unclean_previous_exit);
        let consumer = consumer.with_embedding(embedding);
        let consumer = Arc::new(consumer);
        let shutdown = CancellationToken::new();
        let task = tokio::spawn(poll(
            consumer.clone(),
            data_root.to_path_buf(),
            paths.clone(),
            shutdown.clone(),
        ));
        Ok(Self {
            consumer,
            registration,
            shutdown,
            task: Mutex::new(Some(task)),
        })
    }

    pub(in crate::host) async fn close(&self) -> Result<(), BtccError> {
        self.shutdown.cancel();
        self.consumer.close().await;
        let task = self.task.lock().take();
        let joined = match task {
            Some(task) => task.await.map_err(|source| {
                BtccError::relayed("memory_sync_join_failed", "Memory sync owner failed")
                    .with_source(source)
            }),
            None => Ok(()),
        };
        self.registration.close().await;
        joined
    }
}

/// The longest an idle loop sleeps between polls. In-process work and queue
/// appends end the sleep early; the cap bounds everything else.
const IDLE_CAP: Duration = Duration::from_secs(30);
/// The longest a loop with waiting-but-blocked work sleeps.
const DEFERRED_CAP: Duration = Duration::from_secs(5);

/// The sleep after `idle_polls` consecutive polls that found nothing to do:
/// 1 s, 2 s, 4 s, ... up to `cap`.
fn backoff(idle_polls: u32, cap: Duration) -> Duration {
    let steps = idle_polls.saturating_sub(1).min(16);
    Duration::from_secs(1u64 << steps).min(cap)
}

async fn poll(
    consumer: Arc<MemorySyncConsumer>,
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    shutdown: CancellationToken,
) {
    let mut idle_polls = 0_u32;
    loop {
        if shutdown.is_cancelled() {
            return;
        }
        let generation = active_memory_descriptor_exists(&data_root, &paths);
        let available = matches!(&generation, Ok(true));
        let result = match generation {
            Ok(false) => Ok(MemorySyncPoll::Idle),
            Ok(true) => consumer.poll_once().await,
            Err(error) => Err(error),
        };
        let delay = match result {
            Ok(MemorySyncPoll::Processed) => {
                idle_polls = 0;
                Duration::from_millis(1500)
            }
            Ok(MemorySyncPoll::Idle) => {
                idle_polls = idle_polls.saturating_add(1);
                let delay = backoff(idle_polls, IDLE_CAP);
                if available {
                    consumer.idle_delay(delay)
                } else {
                    delay
                }
            }
            Ok(MemorySyncPoll::Deferred) => {
                idle_polls = idle_polls.saturating_add(1);
                backoff(idle_polls, DEFERRED_CAP)
            }
            Err(_) if shutdown.is_cancelled() => return,
            Err(error) => {
                // Diagnostic codes only. The durable queue retains failed work;
                // paths, prompts, credentials and raw provider errors stay private.
                eprintln!("[native-memory-sync] {}", error.code());
                idle_polls = idle_polls.saturating_add(1);
                backoff(idle_polls, DEFERRED_CAP)
            }
        };
        tokio::select! {
            () = shutdown.cancelled() => return,
            woken = consumer.wait_for_work(delay) => {
                if woken {
                    idle_polls = 0;
                }
            }
        }
    }
}

fn error(error: CognitionError) -> BtccError {
    BtccError::relay(error.code(), error.message(), error)
}
