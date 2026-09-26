//! One tracked semantic projection quantum on the registered Conversation graph.

mod notice;
mod recovery;
mod stages;
pub(crate) use notice::ProjectionSourceNotice;
use notice::assert_notice_current;
use parking_lot::Mutex;

use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{Clock, CognitionRegistrationService, closed, coordination_error};
use crate::cognition::{extraction::CognitionVectorSearch, graph::GraphRepository};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, GraphProgress,
        MemoryGenerationHandle, MemoryGenerationTarget, assert_mutation_authority,
        resolve_generation,
    },
    conversation::ConversationSourceReader,
    coordination::{
        CognitionCoordinationHost, CognitionWaitClass, CognitionWriteAcquire,
        CognitionWriteCoordinator, CognitionWriteLease,
    },
    models::ProviderPromptPort,
};

type ProjectionWindowOwnerKey = (String, String, String);
type ActiveProjectionWindowOwners = Arc<Mutex<HashSet<ProjectionWindowOwnerKey>>>;

pub(super) struct ProjectionDependencies {
    pub provider: Arc<dyn ProviderPromptPort>,
    pub candidates: Arc<dyn CognitionVectorSearch>,
    pub host: Arc<dyn CognitionCoordinationHost>,
}

#[derive(Clone)]
pub(crate) struct ProjectSemanticWindowInput {
    pub data_root: PathBuf,
    pub target: MemoryGenerationTarget,
    pub job_id: String,
    pub notice: ProjectionSourceNotice,
    pub cancellation: Option<CancellationToken>,
    pub deadline_at_epoch_ms: Option<f64>,
    pub wait_class: CognitionWaitClass,
}

struct State {
    input: ProjectSemanticWindowInput,
    handle: MemoryGenerationHandle,
    canonical: ConversationSourceReader,
    graph: GraphRepository,
}

#[derive(Clone)]
struct Operation {
    state: Arc<Mutex<Option<State>>>,
    environment: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    clock: Clock,
    shutdown: CancellationToken,
    cancellation: Option<CancellationToken>,
    deadline_at_epoch_ms: Option<f64>,
    wait_class: CognitionWaitClass,
    lock_path: PathBuf,
}

struct ActiveWindow {
    owners: ActiveProjectionWindowOwners,
    key: (String, String, String),
}
impl Drop for ActiveWindow {
    fn drop(&mut self) {
        self.owners.lock().remove(&self.key);
    }
}

impl CognitionRegistrationService {
    pub(crate) async fn project_semantic_window(
        &self,
        input: ProjectSemanticWindowInput,
    ) -> CognitionResult<Option<GraphProgress>> {
        let deps = self
            .projection
            .as_ref()
            .ok_or_else(|| {
                CognitionError::new(
                    "cognition_projection_unconfigured",
                    "cognition_projection_unconfigured",
                )
            })?
            .clone();
        let permit = self
            .admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| closed())?;
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
        let owners = self.active_windows.clone();
        let (sender, receiver) = oneshot::channel();
        tokio::spawn(async move {
            let _token = token;
            let _permit = permit;
            let result = run(
                environment,
                coordinator,
                clock,
                shutdown,
                owners,
                deps,
                input,
            )
            .await;
            let _ = sender.send(result);
        });
        receiver.await.map_err(|_| {
            CognitionError::new(
                "memory_projection_operation_failed",
                "memory_projection_operation_failed",
            )
        })?
    }
}

async fn run(
    environment: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    clock: Clock,
    shutdown: CancellationToken,
    owners: ActiveProjectionWindowOwners,
    deps: Arc<ProjectionDependencies>,
    input: ProjectSemanticWindowInput,
) -> CognitionResult<Option<GraphProgress>> {
    let prepared_environment = environment.clone();
    let prepared = tokio::task::spawn_blocking(move || prepare(input, &prepared_environment))
        .await
        .map_err(join_error)??;
    let operation = Operation {
        lock_path: environment.consolidation_lock(&prepared.input.data_root),
        cancellation: prepared.input.cancellation.clone(),
        deadline_at_epoch_ms: prepared.input.deadline_at_epoch_ms,
        wait_class: prepared.input.wait_class,
        state: Arc::new(Mutex::new(Some(prepared))),
        environment,
        coordinator,
        clock,
        shutdown,
    };
    let result = execute(&operation, &owners, &deps).await;
    let close = operation.close().await;
    close.and(result)
}

fn prepare(
    input: ProjectSemanticWindowInput,
    environment: &CognitionPathEnvironment,
) -> CognitionResult<State> {
    let handle = resolve_generation(&input.data_root, environment, &input.target)?;
    let canonical_path = handle
        .canonical_snapshot_path
        .clone()
        .unwrap_or_else(|| handle.source_root.join("runtime/conversation-store.sqlite"));
    let canonical = ConversationSourceReader::open(&canonical_path).map_err(conversation_error)?;
    let graph = GraphRepository::open(&handle.graph_path)?;
    Ok(State {
        input,
        handle,
        canonical,
        graph,
    })
}

async fn execute(
    operation: &Operation,
    owners: &ActiveProjectionWindowOwners,
    deps: &ProjectionDependencies,
) -> CognitionResult<Option<GraphProgress>> {
    let host = deps.host.clone();
    let active = owners.lock().clone();
    let claim_owners = owners.clone();
    let nonce = host.new_uuid();
    let now = (operation.clock)();
    let claim = operation
        .write(move |state| {
            let claim = state.graph.claim_projection_window(
                crate::cognition::graph::ClaimProjectionWindowInput {
                    job_id: Some(&state.input.job_id),
                    now: &now,
                    owner_pid: host.process_id(),
                    owner_nonce: &nonce,
                    active_owners: &active,
                    process_status: &|pid| host.process_status(pid),
                },
            )?;
            if let Some(claim) = &claim {
                claim_owners.lock().insert((
                    claim.job_id.clone(),
                    claim.window_ref.clone(),
                    claim.owner_nonce.clone(),
                ));
            }
            Ok(claim)
        })
        .await?;
    let Some(claim) = claim else { return Ok(None) };
    let key = (
        claim.job_id.clone(),
        claim.window_ref.clone(),
        claim.owner_nonce.clone(),
    );
    let _active = ActiveWindow {
        owners: owners.clone(),
        key,
    };
    let claim = Arc::new(claim);
    let adapter_entered = Arc::new(AtomicBool::new(false));
    let result = execute_claimed(operation, &claim, deps, adapter_entered.clone()).await;
    match result {
        Ok(progress) => Ok(Some(progress)),
        Err(error) => {
            let settlement =
                operation.settlement(deps.host.now_epoch_millis().saturating_add(5_000));
            let job = claim.job_id.clone();
            let window = claim.window_ref.clone();
            let nonce = claim.owner_nonce.clone();
            let code = error.code;
            let repair_exhausted = error.message.starts_with("repair_exhausted:");
            let clock = operation.clock.clone();
            let invoked = adapter_entered.load(Ordering::Acquire);
            settlement
                .write(move |state| {
                    assert_current(state, &clock())?;
                    if matches!(
                        code,
                        "memory_extract_needs_context" | "memory_extract_unsupported"
                    ) {
                        let pinned = state.graph.pinned_extract_input(&window, &nonce)?;
                        let revised = if code == "memory_extract_needs_context"
                            && pinned.context_expansion.unwrap_or(0.0) < 1.0
                        {
                            state
                                .graph
                                .expand_context(
                                    &state.canonical,
                                    &state.handle.source_root,
                                    &pinned,
                                )
                                .ok()
                        } else {
                            None
                        };
                        state.graph.record_window_disposition(
                            crate::cognition::graph::ProjectionWindowOwner {
                                job_id: &job,
                                window_ref: &window,
                                nonce: &nonce,
                            },
                            if code == "memory_extract_needs_context" {
                                "needs_context"
                            } else {
                                "unsupported"
                            },
                            revised.as_ref(),
                            &clock(),
                            invoked,
                        )?;
                    } else {
                        state.graph.settle_window_failure(
                            crate::cognition::graph::ProjectionWindowOwner {
                                job_id: &job,
                                window_ref: &window,
                                nonce: &nonce,
                            },
                            code,
                            &clock(),
                            invoked,
                            repair_exhausted,
                        )?;
                    }
                    state.graph.progress(&job)
                })
                .await
                .map(Some)
        }
    }
}

async fn execute_claimed(
    operation: &Operation,
    claim: &Arc<crate::cognition::graph::ClaimedProjectionWindow>,
    deps: &ProjectionDependencies,
    adapter_entered: Arc<AtomicBool>,
) -> CognitionResult<GraphProgress> {
    let prepared_claim = claim.clone();
    let current_clock = operation.clock.clone();
    let pinned = operation
        .read(move |state| {
            let input = if let Some(value) = &prepared_claim.pinned_input {
                serde_json::from_value(value.clone()).map_err(json_error)?
            } else {
                state.graph.build_extract_input(
                    &state.canonical,
                    &state.handle.source_root,
                    &prepared_claim.job_id,
                    &prepared_claim.window_ref,
                    &prepared_claim.source_refs,
                )?
            };
            assert_notice_current(state, &input.revision, &current_clock())?;
            Ok(input)
        })
        .await?;
    let pin_input = pinned.clone();
    let pin_claim = claim.clone();
    let pin_clock = operation.clock.clone();
    operation
        .write(move |state| {
            assert_current(state, &pin_clock())?;
            state.graph.pin_projection_input(
                &pin_claim.window_ref,
                &pin_claim.owner_nonce,
                &serde_json::to_value(&pin_input).map_err(json_error)?,
                None,
            )
        })
        .await?;
    // Stage execution and same-operation final apply are owned by `stages`.
    stages::execute(
        operation.clone(),
        claim.clone(),
        pinned,
        deps,
        adapter_entered,
    )
    .await
}

impl Operation {
    fn settlement(&self, deadline_at_epoch_ms: i64) -> Self {
        let mut settled = self.clone();
        settled.cancellation = None;
        settled.shutdown = CancellationToken::new();
        settled.deadline_at_epoch_ms = Some(deadline_at_epoch_ms as f64);
        settled
    }
    async fn acquire(&self) -> CognitionResult<CognitionWriteLease> {
        if self.shutdown.is_cancelled()
            || self
                .cancellation
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(CognitionError::new(
                "memory_write_aborted",
                "memory_write_aborted",
            ));
        }
        let request = CognitionWriteAcquire {
            lock_path: self.lock_path.clone(),
            purpose: Some("projection".into()),
            deadline_at_epoch_ms: self.deadline_at_epoch_ms,
            cancellation: Some(
                self.cancellation
                    .clone()
                    .unwrap_or_else(|| self.shutdown.clone()),
            ),
        };
        let acquire = self.coordinator.acquire(request, self.wait_class);
        let lease = if let Some(cancel) = &self.cancellation {
            tokio::select! {biased;() = self.shutdown.cancelled()=>return Err(write_aborted()),() = cancel.cancelled()=>return Err(write_aborted()),result=acquire=>result.map_err(coordination_error)?}
        } else {
            tokio::select! {biased;() = self.shutdown.cancelled()=>return Err(write_aborted()),result=acquire=>result.map_err(coordination_error)?}
        };
        lease.ok_or_else(|| CognitionError::new("memory_write_busy", "memory_write_busy"))
    }
    async fn write<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut State) -> CognitionResult<T> + Send + 'static,
    ) -> CognitionResult<T> {
        let lease = self.acquire().await?;
        let shared = self.state.clone();
        let lock_path = self.lock_path.clone();
        let environment = self.environment.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = shared.lock();
            let state = guard.as_mut().ok_or_else(closed)?;
            lease
                .assert_for_path(&lock_path)
                .map_err(coordination_error)?;
            let result = assert_mutation_authority(
                &state.input.data_root,
                &environment,
                &state.input.target,
                &state.handle,
            )
            .and_then(|()| operation(state));
            let release = lease.release(result.is_ok()).map_err(coordination_error);
            release.and(result)
        })
        .await
        .map_err(join_error)?
    }
    async fn read<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut State) -> CognitionResult<T> + Send + 'static,
    ) -> CognitionResult<T> {
        let shared = self.state.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = shared.lock();
            operation(guard.as_mut().ok_or_else(closed)?)
        })
        .await
        .map_err(join_error)?
    }
    async fn close(&self) -> CognitionResult<()> {
        let shared = self.state.clone();
        tokio::task::spawn_blocking(move || {
            let state = shared.lock().take().ok_or_else(closed)?;
            let graph = state.graph.close();
            let canonical = state.canonical.close().map_err(conversation_error);
            canonical.and(graph)
        })
        .await
        .map_err(join_error)?
    }
}

fn assert_current(state: &State, now: &str) -> CognitionResult<()> {
    let revision = state.graph.job_revision(&state.input.job_id)?;
    assert_notice_current(state, &revision, now)
}

fn write_aborted() -> CognitionError {
    CognitionError::new("memory_write_aborted", "memory_write_aborted")
}
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn join_error(error: tokio::task::JoinError) -> CognitionError {
    CognitionError::new("memory_projection_operation_failed", error.to_string())
}
fn conversation_error(error: crate::conversation::ConversationError) -> CognitionError {
    CognitionError::new(error.code, error.message)
}
fn json_error(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_extract_invalid_json", error.to_string())
}
