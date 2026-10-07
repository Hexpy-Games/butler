//! Tracked canonical Conversation registration into an existing Cognition generation.

mod internal_control;
mod projection;
mod typed;
mod typed_lifecycle;
mod types;

use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{Semaphore, oneshot};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::graph::{GraphRepository, RegistrationInput};
use super::{
    CognitionError, CognitionPathEnvironment, CognitionResult, CognitionSourcePlan,
    MemoryGenerationHandle, PreparedConversationSource, assert_mutation_authority,
    prepare_conversation_source, resolve_generation,
};
use crate::coordination::{CognitionWriteAcquire, CognitionWriteCoordinator, CognitionWriteLease};
use butler_turn::conversation::ConversationSourceReader;

use crate::cognition::CognitionCode;
pub(crate) use projection::{ProjectSemanticWindowInput, ProjectionSourceNotice};
pub use typed::RegisterTypedSourceInput;
pub use types::OwnedConversationSourceNotice as CognitionConversationSourceNotice;
pub use types::{ConversationRegistrationOutcome, RegisterConversationSourceInput};
mod stages;
use stages::Stages;

/// A typed-memory lifecycle change (retraction or supersession) to apply to the graph.
pub struct ConsumeTypedLifecycleInput {
    /// Butler data root.
    pub data_root: PathBuf,
    /// Generation the caller saw as active.
    pub expected_generation: String,
    /// `task_report` or `explicit_record`.
    pub source_kind: String,
    /// Record id.
    pub record_id: String,
    /// Record revision.
    pub revision: String,
    /// Operation that changed the lifecycle.
    pub operation_id: String,
    /// The new lifecycle.
    pub disposition: super::sources::TypedMemoryLifecycle,
    /// Stops the operation when cancelled.
    pub cancellation: CancellationToken,
}

const OPERATION_LIMIT: usize = 4;

type Clock = Arc<dyn Fn() -> String + Send + Sync>;
type GraphPool = Arc<Mutex<Option<(PathBuf, Vec<GraphRepository>)>>>;
type IdlePool = std::sync::Weak<Mutex<Option<(PathBuf, Vec<GraphRepository>)>>>;
static IDLE_POOLS: std::sync::LazyLock<Mutex<HashMap<PathBuf, IdlePool>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
pub(in crate::cognition) fn retire_idle_graphs(path: &std::path::Path) {
    let mut pools = IDLE_POOLS.lock();
    if let Some(pool) = pools.remove(path).and_then(|pool| pool.upgrade()) {
        let mut pool = pool.lock();
        if pool.as_ref().is_some_and(|(current, _)| current == path) {
            *pool = None;
        }
    }
}

/// Registers conversation and typed sources in a memory generation and projects them into the
/// graph.
pub struct CognitionRegistrationService {
    environment: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    clock: Clock,
    admission: Arc<Semaphore>,
    shutdown: CancellationToken,
    operations: TaskTracker,
    lifecycle: Mutex<Lifecycle>,
    projection: Option<Arc<projection::ProjectionDependencies>>,
    active_windows: Arc<Mutex<HashSet<(String, String, String)>>>,
    /// Graph databases whose schema this process already ensured.
    schema_ready: Arc<Mutex<HashSet<PathBuf>>>,
    graph_pool: GraphPool,
}

struct Lifecycle {
    closing: bool,
}

struct OperationState {
    input: RegisterConversationSourceInput,
    handle: MemoryGenerationHandle,
    plan: CognitionSourcePlan,
    canonical: ConversationSourceReader,
    graph: GraphRepository,
    graph_pool: GraphPool,
    extraction_model: String,
    reasoning_effort: String,
}

impl CognitionRegistrationService {
    pub(crate) fn new(
        environment: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
        clock: Clock,
    ) -> Self {
        Self {
            environment,
            coordinator,
            clock,
            admission: Arc::new(Semaphore::new(OPERATION_LIMIT)),
            shutdown: CancellationToken::new(),
            operations: TaskTracker::new(),
            lifecycle: Mutex::new(Lifecycle { closing: false }),
            projection: None,
            active_windows: Arc::new(Mutex::new(HashSet::new())),
            schema_ready: Arc::new(Mutex::new(HashSet::new())),
            graph_pool: Arc::new(Mutex::new(None)),
        }
    }

    /// A registration service that can also project semantic windows with the extractor model.
    pub fn with_projection(
        environment: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
        clock: Clock,
        provider: Arc<dyn butler_models::models::ProviderPromptPort>,
        candidates: Arc<dyn crate::cognition::extraction::CognitionVectorSearch>,
        host: Arc<dyn crate::coordination::CognitionCoordinationHost>,
    ) -> Self {
        let mut service = Self::new(environment, coordinator, clock);
        service.projection = Some(Arc::new(projection::ProjectionDependencies {
            provider,
            candidates,
            host,
        }));
        service
    }

    pub(crate) async fn register_conversation_source(
        &self,
        input: RegisterConversationSourceInput,
    ) -> CognitionResult<ConversationRegistrationOutcome> {
        let permit = self
            .admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|source| closed().with_source(source))?;
        let token = {
            let lifecycle = self.lifecycle.lock();
            if lifecycle.closing {
                return Err(closed());
            }
            self.operations.token()
        };
        let environment = self.environment.clone();
        let coordinator = self.coordinator.clone();
        let clock = self.clock.clone();
        let shutdown = self.shutdown.clone();
        let schema_ready = self.schema_ready.clone();
        let graph_pool = self.graph_pool.clone();
        let (sender, receiver) = oneshot::channel();
        // Detached on purpose: the operation token/guard moved into the task keeps the
        // owner's close waiting for it, and the result returns through the oneshot,
        // so a cancelled caller cannot abandon the operation midway.
        tokio::spawn(async move {
            let _token = token;
            let _permit = permit;
            let result = operation(
                environment,
                coordinator,
                clock,
                shutdown,
                schema_ready,
                graph_pool,
                input,
            )
            .await;
            let _ = sender.send(result);
        });
        receiver.await.map_err(|source| {
            CognitionError::new(
                CognitionCode::MemoryRegistrationOperationFailed,
                "memory_registration_operation_failed",
            )
            .with_source(source)
        })?
    }

    /// Stops admitting registrations and waits for running ones.
    pub async fn close(&self) {
        {
            let mut lifecycle = self.lifecycle.lock();
            if !lifecycle.closing {
                lifecycle.closing = true;
                self.shutdown.cancel();
                self.operations.close();
                self.admission.close();
            }
        }
        self.operations.wait().await;
        *self.graph_pool.lock() = None;
    }
}

async fn operation(
    environment: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    clock: Clock,
    shutdown: CancellationToken,
    schema_ready: Arc<Mutex<HashSet<PathBuf>>>,
    graph_pool: GraphPool,
    input: RegisterConversationSourceInput,
) -> CognitionResult<ConversationRegistrationOutcome> {
    check_cancelled(&shutdown, input.cancellation.as_ref())?;
    let now = clock();
    let initial_environment = environment.clone();
    let prepared =
        tokio::task::spawn_blocking(move || prepare(input, &initial_environment, &now, graph_pool))
            .await
            .map_err(join_error)??;
    let state = match prepared {
        InitialPreparation::Handoff(handoff) => {
            let SupersessionHandoff {
                input,
                handle,
                turn_id,
            } = *handoff;
            return internal_control::run(internal_control::Input {
                environment,
                coordinator,
                clock,
                shutdown,
                input,
                handle,
                turn_id,
            })
            .await;
        }
        InitialPreparation::Ready(state) => state,
    };
    let stages = Stages {
        environment,
        coordinator,
        clock,
        shutdown,
    };
    // The schema check writes under the lease; once per graph database is enough.
    let graph_path = state.handle.graph_path.clone();
    let state = if schema_ready.lock().contains(&graph_path) {
        state
    } else {
        let state = stages.ensure_schema(state).await?;
        schema_ready.lock().insert(graph_path);
        state
    };
    match stages.replay(state).await? {
        ReplayStage::Complete(progress) => Ok(ConversationRegistrationOutcome::Replayed(*progress)),
        ReplayStage::Continue(state) => stages.register(state).await,
    }
}

enum InitialPreparation {
    Handoff(Box<SupersessionHandoff>),
    Ready(Box<OperationState>),
}

struct SupersessionHandoff {
    input: RegisterConversationSourceInput,
    handle: MemoryGenerationHandle,
    turn_id: String,
}

enum ReplayStage {
    Continue(Box<OperationState>),
    Complete(Box<super::GraphProgress>),
}

fn prepare(
    input: RegisterConversationSourceInput,
    environment: &CognitionPathEnvironment,
    now: &str,
    graph_pool: GraphPool,
) -> CognitionResult<InitialPreparation> {
    let handle = resolve_generation(&input.data_root, environment, &input.target)?;
    super::admission::assert_admitted(&handle.graph_path, &input.notice)?;
    let canonical_path = handle
        .canonical_snapshot_path
        .clone()
        .unwrap_or_else(|| handle.source_root.join("runtime/conversation-store.sqlite"));
    let canonical =
        ConversationSourceReader::open(&canonical_path).map_err(CognitionError::from)?;
    let prepared = prepare_conversation_source(&canonical, input.notice.borrowed(), now)?;
    let plan = match prepared {
        PreparedConversationSource::SupersedeInternalControl { turn_id } => {
            canonical.close().map_err(CognitionError::from)?;
            return Ok(InitialPreparation::Handoff(Box::new(SupersessionHandoff {
                input,
                handle,
                turn_id,
            })));
        }
        PreparedConversationSource::Plan(plan) => *plan,
    };
    let model = crate::profile::read_profiling_extractor_model(&handle.source_root);
    let graph = {
        let mut pool = graph_pool.lock();
        match pool.as_mut() {
            Some((path, graphs)) if path == &handle.graph_path => graphs.pop(),
            _ => None,
        }
    }
    .map_or_else(|| GraphRepository::open(&handle.graph_path), Ok)?;
    Ok(InitialPreparation::Ready(Box::new(OperationState {
        input,
        handle,
        plan,
        canonical,
        graph,
        graph_pool,
        extraction_model: model.effective_model,
        reasoning_effort: model.reasoning_effort,
    })))
}

async fn close_after_failure<T>(
    state: Box<OperationState>,
    operation_error: CognitionError,
) -> CognitionResult<T> {
    tokio::task::spawn_blocking(move || close_with_error(state, operation_error))
        .await
        .map_err(join_error)
        .and_then(Err)
}

fn close_state(state: Box<OperationState>) -> CognitionResult<()> {
    let OperationState {
        handle,
        graph,
        graph_pool,
        canonical,
        ..
    } = *state;
    canonical.close().map_err(CognitionError::from)?;
    graph.sync_wal_index()?;
    let mut pools = IDLE_POOLS.lock();
    if handle
        .reader_pin
        .as_ref()
        .is_some_and(super::generation::pins::GenerationPin::is_retiring)
    {
        return graph.close();
    }
    pools.retain(|_, pool| pool.strong_count() > 0);
    pools.insert(handle.graph_path.clone(), Arc::downgrade(&graph_pool));
    let mut pool = graph_pool.lock();
    match pool.as_mut() {
        Some((path, graphs)) if path == &handle.graph_path => graphs.push(graph),
        _ => *pool = Some((handle.graph_path, vec![graph])),
    }
    Ok(())
}

fn close_with_error(state: Box<OperationState>, operation_error: CognitionError) -> CognitionError {
    let OperationState {
        graph, canonical, ..
    } = *state;
    let graph_close = graph.close();
    let canonical_close = canonical.close().map_err(CognitionError::from);
    canonical_close
        .and(graph_close)
        .err()
        .unwrap_or(operation_error)
}

async fn acquire(
    coordinator: &CognitionWriteCoordinator,
    lock_path: PathBuf,
    input: &RegisterConversationSourceInput,
    shutdown: &CancellationToken,
) -> CognitionResult<CognitionWriteLease> {
    if shutdown.is_cancelled()
        || input
            .cancellation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
    {
        return Err(write_aborted());
    }
    let request_cancellation = input
        .cancellation
        .clone()
        .unwrap_or_else(|| shutdown.clone());
    let request = CognitionWriteAcquire {
        lock_path,
        purpose: Some("projection".into()),
        deadline_at_epoch_ms: input.deadline_at_epoch_ms,
        cancellation: Some(request_cancellation),
    };
    let acquire = coordinator.acquire(request, input.wait_class);
    let lease = if let Some(cancellation) = &input.cancellation {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => return Err(write_aborted()),
            () = cancellation.cancelled() => return Err(write_aborted()),
            result = acquire => result.map_err(CognitionError::from)?,
        }
    } else {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => return Err(write_aborted()),
            result = acquire => result.map_err(CognitionError::from)?,
        }
    };
    lease.ok_or_else(|| CognitionError::new(CognitionCode::MemoryWriteBusy, "memory_write_busy"))
}

fn mutate<T>(
    state: &mut OperationState,
    lease: CognitionWriteLease,
    lock_path: &std::path::Path,
    environment: &CognitionPathEnvironment,
    operation: impl FnOnce(&mut OperationState) -> CognitionResult<T>,
) -> CognitionResult<T> {
    lease
        .assert_for_path(lock_path)
        .map_err(CognitionError::from)?;
    let result = assert_mutation_authority(
        &state.input.data_root,
        environment,
        &state.input.target,
        &state.handle,
    )
    .and_then(|()| operation(state));
    let release = lease.release(result.is_ok()).map_err(CognitionError::from);
    release.and(result)
}

fn check_cancelled(
    shutdown: &CancellationToken,
    cancellation: Option<&CancellationToken>,
) -> CognitionResult<()> {
    if shutdown.is_cancelled() || cancellation.is_some_and(CancellationToken::is_cancelled) {
        Err(aborted())
    } else {
        Ok(())
    }
}

fn aborted() -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryProjectionAborted,
        "memory_projection_aborted",
    )
}
fn write_aborted() -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryWriteAborted,
        "Memory writer acquisition was aborted",
    )
}
fn closed() -> CognitionError {
    CognitionError::new(CognitionCode::CognitionClosed, "cognition_closed")
}
fn join_error(error: tokio::task::JoinError) -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryRegistrationOperationFailed,
        error.to_string(),
    )
    .with_source(error)
}

#[cfg(test)]
mod tests;
