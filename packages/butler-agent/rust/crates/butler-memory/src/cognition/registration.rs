//! Tracked canonical Conversation registration into an existing Cognition generation.

mod internal_control;
mod projection;
mod typed;
mod typed_lifecycle;
mod types;

use parking_lot::Mutex;
use std::collections::HashSet;
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

pub struct ConsumeTypedLifecycleInput {
    pub data_root: PathBuf,
    pub expected_generation: String,
    pub source_kind: String,
    pub record_id: String,
    pub revision: String,
    pub operation_id: String,
    pub disposition: super::sources::TypedMemoryLifecycle,
    pub cancellation: CancellationToken,
}

const OPERATION_LIMIT: usize = 4;

type Clock = Arc<dyn Fn() -> String + Send + Sync>;

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
        }
    }

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
        let (sender, receiver) = oneshot::channel();
        // Detached on purpose: the operation token/guard moved into the task keeps the
        // owner's close waiting for it, and the result returns through the oneshot,
        // so a cancelled caller cannot abandon the operation midway.
        tokio::spawn(async move {
            let _token = token;
            let _permit = permit;
            let result = operation(environment, coordinator, clock, shutdown, input).await;
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
    }
}

async fn operation(
    environment: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    clock: Clock,
    shutdown: CancellationToken,
    input: RegisterConversationSourceInput,
) -> CognitionResult<ConversationRegistrationOutcome> {
    check_cancelled(&shutdown, input.cancellation.as_ref())?;
    let now = clock();
    let initial_environment = environment.clone();
    let prepared = tokio::task::spawn_blocking(move || prepare(input, &initial_environment, &now))
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
    let state = stages.ensure_schema(state).await?;
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
) -> CognitionResult<InitialPreparation> {
    let handle = resolve_generation(&input.data_root, environment, &input.target)?;
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
    let graph = GraphRepository::open(&handle.graph_path)?;
    Ok(InitialPreparation::Ready(Box::new(OperationState {
        input,
        handle,
        plan,
        canonical,
        graph,
        extraction_model: model.effective_model,
        reasoning_effort: model.reasoning_effort,
    })))
}

async fn close_after_failure<T>(
    state: Box<OperationState>,
    operation_error: CognitionError,
) -> CognitionResult<T> {
    tokio::task::spawn_blocking(move || close_state(state))
        .await
        .map_err(join_error)??;
    Err(operation_error)
}

fn close_state(state: Box<OperationState>) -> CognitionResult<()> {
    let graph_close = state.graph.close();
    let canonical_close = state.canonical.close().map_err(CognitionError::from);
    canonical_close.and(graph_close)
}

fn close_with_error(state: Box<OperationState>, operation_error: CognitionError) -> CognitionError {
    close_state(state).err().unwrap_or(operation_error)
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
