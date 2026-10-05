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
    CognitionError, CognitionPathEnvironment, CognitionRegistrationService, FreshMemoryGeneration,
};
use butler_memory::cognition::{MemorySyncConsumer, MemorySyncPoll};
use butler_memory::cognition::{active_memory_descriptor_exists, resolve_active_generation};
use butler_memory::coordination::CognitionWriteCoordinator;
use butler_models::models::{ModelConfigurationClock, ModelProvider};
use butler_turn::btcc::BtccError;
mod source_probe;

use crate::host::SystemIdentity;

pub(in crate::host) struct MemorySync {
    consumer: Arc<MemorySyncConsumer>,
    registration: Arc<CognitionRegistrationService>,
    shutdown: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

pub(in crate::host) struct MemorySyncStartup<'a> {
    pub data_root: &'a Path,
    pub paths: &'a CognitionPathEnvironment,
    pub unclean_previous_exit: bool,
    pub fresh: Option<FreshMemoryGeneration>,
}

impl MemorySync {
    pub(in crate::host) fn consumer(&self) -> Arc<MemorySyncConsumer> {
        self.consumer.clone()
    }

    pub(in crate::host) async fn open(
        startup: MemorySyncStartup<'_>,
        coordinator: Arc<CognitionWriteCoordinator>,
        provider: Arc<ModelProvider>,
        embedding: Arc<EmbeddingOwner>,
        vector: Arc<GenerationVectorAdapter>,
    ) -> Result<Self, BtccError> {
        let MemorySyncStartup {
            data_root,
            paths,
            unclean_previous_exit,
            fresh,
        } = startup;
        let changes = observe_changes(data_root, paths).await?;
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
        let instruction_owner = crate::host::guided::tools::MemoryWriteServices::new(
            data_root,
            paths,
            coordinator.clone(),
            clock.clone(),
        )
        .rules;
        let consumer = MemorySyncConsumer::new(
            data_root.to_path_buf(),
            paths.clone(),
            registration.clone(),
            coordinator,
            clock,
        )
        .with_instruction_owner(instruction_owner)
        .with_unclean_start(unclean_previous_exit);
        let consumer = consumer.with_embedding(embedding);
        let consumer = Arc::new(consumer);
        let shutdown = CancellationToken::new();
        let task = tokio::spawn(poll(
            consumer.clone(),
            data_root.to_path_buf(),
            paths.clone(),
            shutdown.clone(),
            fresh,
            changes,
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

/// Recovery of unfinished semantic/vector work keeps its existing backoff cap.
/// A fully idle consumer waits for a native or in-process change.
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
    fresh: Option<FreshMemoryGeneration>,
    mut changes: butler_gateway::gateway::FileChangeWatch,
) {
    if !initialize(fresh, &data_root, &shutdown).await {
        return;
    }
    let mut idle_polls = 0_u32;
    loop {
        if shutdown.is_cancelled() {
            return;
        }
        let delay = poll_delay(&consumer, &data_root, &paths, &shutdown, &mut idle_polls).await;
        trace(&format!("park delay={delay:?}"));
        tokio::select! {
            () = shutdown.cancelled() => return,
            changed = changes.changed() => {
                idle_polls = 0;
                match changed {
                    Ok(true) => {
                        trace("source_changed");
                        // Stub-only race gate: the durable completion queue must
                        // suffice when filesystem notifications are coalesced.
                        if !(std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
                            && std::env::var("BUTLER_E2E_HOLD_CANONICAL_WAKE").as_deref() == Ok("1"))
                        {
                            consumer.source_changed();
                        }
                    },
                    Ok(false) => { trace("root_changed"); },
                    Err(_) => {
                        let Some(observer) = recover_observer(&data_root, &paths, &shutdown).await else { return };
                        changes = observer;
                        consumer.source_changed();
                    }
                }
            }
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

async fn observe_changes(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
) -> Result<butler_gateway::gateway::FileChangeWatch, BtccError> {
    let canonical = butler_turn::conversation::conversation_store_path(data_root);
    let wal = canonical.with_file_name(format!(
        "{}-wal",
        canonical.file_name().unwrap_or_default().to_string_lossy()
    ));
    let mut probe = source_probe::SourceProbe::new(canonical.clone());
    butler_gateway::gateway::FileChangeWatch::observe_with_close_probe(
        paths.memory_root(data_root),
        vec![canonical, wal],
        move || probe.changed(),
    )
    .await
    .map_err(|source| {
        BtccError::relayed(
            "memory_sync_observer_failed",
            "Memory change observer failed",
        )
        .with_source(source)
    })
}

async fn initialize(
    fresh: Option<FreshMemoryGeneration>,
    data_root: &Path,
    shutdown: &CancellationToken,
) -> bool {
    if let Some(fresh) = fresh {
        if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
            && std::env::var("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP").as_deref() == Ok("1")
        {
            while !tokio::fs::try_exists(data_root.join("state/e2e-memory-bootstrap-release"))
                .await
                .unwrap_or(false)
            {
                tokio::select! {
                    () = shutdown.cancelled() => return false,
                    () = tokio::time::sleep(Duration::from_millis(20)) => {},
                }
            }
        }
        if shutdown.is_cancelled() {
            return false;
        }
        if let Err(error) = fresh.initialize().await {
            eprintln!("[native-memory-bootstrap] {}", error.code());
            return false;
        }
    }
    true
}

async fn poll_delay(
    consumer: &MemorySyncConsumer,
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    shutdown: &CancellationToken,
    idle_polls: &mut u32,
) -> Option<Duration> {
    let generation = active_memory_descriptor_exists(data_root, paths);
    let available = matches!(&generation, Ok(true));
    let result = match generation {
        Ok(false) => Ok(MemorySyncPoll::Idle),
        Ok(true) => consumer.poll_once().await,
        Err(error) => Err(error),
    };
    let outcome = match &result {
        Ok(MemorySyncPoll::Processed) => "processed",
        Ok(MemorySyncPoll::Idle) => "idle",
        Ok(MemorySyncPoll::Deferred) => "deferred",
        Err(error) => error.code(),
    };
    trace(outcome);
    match result {
        Ok(MemorySyncPoll::Processed) => {
            *idle_polls = 0;
            Some(Duration::from_millis(1500))
        }
        Ok(MemorySyncPoll::Idle) => {
            *idle_polls = idle_polls.saturating_add(1);
            let delay = backoff(*idle_polls, IDLE_CAP);
            if available {
                match consumer.idle_delay(delay).await {
                    Ok(delay) => delay,
                    Err(error) => {
                        butler_core::diagnostic!("[native-memory-sync] {}", error.code());
                        Some(backoff(*idle_polls, DEFERRED_CAP))
                    }
                }
            } else {
                None
            }
        }
        Ok(MemorySyncPoll::Deferred) => {
            *idle_polls = idle_polls.saturating_add(1);
            Some(backoff(*idle_polls, DEFERRED_CAP))
        }
        Err(_) if shutdown.is_cancelled() => None,
        Err(error) => {
            // Diagnostic codes only. The durable queue retains failed work;
            // paths, prompts, credentials and raw provider errors stay private.
            butler_core::diagnostic!("[native-memory-sync] {}", error.code());
            *idle_polls = idle_polls.saturating_add(1);
            Some(backoff(*idle_polls, DEFERRED_CAP))
        }
    }
}

async fn recover_observer(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    shutdown: &CancellationToken,
) -> Option<butler_gateway::gateway::FileChangeWatch> {
    butler_core::diagnostic!("[native-memory-sync] memory_sync_observer_failed");
    loop {
        tokio::select! {
            () = shutdown.cancelled() => return None,
            () = tokio::time::sleep(DEFERRED_CAP) => {},
        }
        if let Ok(observer) = observe_changes(data_root, paths).await {
            return Some(observer);
        }
    }
}

fn trace(message: &str) {
    if std::env::var("BUTLER_E2E_MEMORY_SYNC_TRACE").as_deref() == Ok("1") {
        butler_core::diagnostic!("[memory-sync-trace] {message}");
    }
}
