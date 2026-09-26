//! Snapshot-owned typed registration for rebuild candidates.

use std::{path::PathBuf, sync::Arc};

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{CognitionRegistrationService, closed, coordination_error, join_error};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationTarget,
        assert_mutation_authority, ensure_data_authority,
        graph::{GraphRepository, TypedRegistrationInput},
        resolve_generation,
        sources::{TypedMemoryRecord, TypedPlan, prepare_typed_source, read_typed_record},
    },
    conversation::{ConversationSourceReader, conversation_store_path},
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

#[derive(Clone)]
pub(crate) struct RegisterTypedSourceInput {
    pub data_root: PathBuf,
    pub target: MemoryGenerationTarget,
    pub source_kind: String,
    pub record_id: String,
    pub revision: String,
    pub operation_id: String,
    pub content_hash: String,
    pub completion_id: String,
    pub cancellation: CancellationToken,
}

impl CognitionRegistrationService {
    pub(crate) async fn register_typed_source(
        &self,
        input: RegisterTypedSourceInput,
    ) -> CognitionResult<crate::cognition::GraphProgress> {
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
        let (sender, receiver) = oneshot::channel();
        tokio::spawn(async move {
            let _token = token;
            let _permit = permit;
            let result = run(input, environment, coordinator, clock, shutdown).await;
            let _ = sender.send(result);
        });
        receiver.await.map_err(|_| {
            CognitionError::new(
                "memory_registration_operation_failed",
                "memory_registration_operation_failed",
            )
        })?
    }
}

async fn run(
    input: RegisterTypedSourceInput,
    environment: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    clock: Arc<dyn Fn() -> String + Send + Sync>,
    shutdown: CancellationToken,
) -> CognitionResult<crate::cognition::GraphProgress> {
    if shutdown.is_cancelled() || input.cancellation.is_cancelled() {
        return Err(aborted());
    }
    let lock = environment.consolidation_lock(&input.data_root);
    let cognition_root = environment.cognition_root(&input.data_root);
    ensure_data_authority(&input.data_root, &[&lock, &cognition_root])?;
    let preflight_input = input.clone();
    let preflight_environment = environment.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        prepare_typed(&preflight_input, &preflight_environment)
    })
    .await
    .map_err(join_error)??;
    if shutdown.is_cancelled() || input.cancellation.is_cancelled() {
        return Err(aborted());
    }
    let acquisition = coordinator.acquire(
        CognitionWriteAcquire {
            lock_path: lock.clone(),
            purpose: Some(match &input.target {
                MemoryGenerationTarget::Active { .. } => "typed_registration".into(),
                MemoryGenerationTarget::Rebuild { .. } => "rebuild_typed_registration".into(),
            }),
            deadline_at_epoch_ms: None,
            cancellation: Some(input.cancellation.clone()),
        },
        CognitionWaitClass::Background,
    );
    let lease = tokio::select! {
        biased;
        () = shutdown.cancelled() => return Err(aborted()),
        () = input.cancellation.cancelled() => return Err(aborted()),
        acquired = acquisition => acquired.map_err(coordination_error)?.ok_or_else(aborted)?,
    };
    tokio::task::spawn_blocking(move || {
        let result = (|| {
            lease.assert_for_path(&lock).map_err(coordination_error)?;
            if shutdown.is_cancelled() || input.cancellation.is_cancelled() {
                return Err(aborted());
            }
            let current = resolve_generation(&input.data_root, &environment, &input.target)?;
            assert_mutation_authority(&input.data_root, &environment, &input.target, &current)?;
            ensure_data_authority(
                &input.data_root,
                &[&current.root, &current.graph_path, &current.source_root],
            )?;
            if current.generation_id != prepared.handle.generation_id
                || current.source_root != prepared.handle.source_root
            {
                return Err(source_changed());
            }
            let canonical = ConversationSourceReader::open(&prepared.canonical_path)
                .map_err(|_| source_changed())?;
            let mut graph = match GraphRepository::open(&current.graph_path) {
                Ok(graph) => graph,
                Err(error) => {
                    return Err(canonical
                        .close()
                        .map_err(|_| source_changed())
                        .err()
                        .unwrap_or(error));
                }
            };
            let now = clock();
            let (cursor_key, snapshot_id) = match &input.target {
                MemoryGenerationTarget::Rebuild {
                    canonical_snapshot_id,
                    ..
                } => (
                    Some(prepared.plan.source_key.as_str()),
                    Some(canonical_snapshot_id.as_str()),
                ),
                MemoryGenerationTarget::Active { .. } => (None, None),
            };
            let registered = (|| {
                graph.ensure_schema(&now)?;
                let result = graph.register_typed(TypedRegistrationInput {
                    generation_id: &current.generation_id,
                    data_root: &current.source_root,
                    memory_root: &current.source_root.join("cognition/memory"),
                    plan: &prepared.plan,
                    owner: &prepared.owner,
                    canonical: &canonical,
                    cursor_key,
                    cursor_snapshot_id: snapshot_id,
                    completion_id: Some(&input.completion_id),
                    extraction_model: &prepared.extraction_model,
                    reasoning_effort: &prepared.reasoning_effort,
                    clock: clock.as_ref(),
                })?;
                graph.progress(&result.job_id)
            })();
            let graph_close = graph.close();
            let canonical_close = canonical.close().map_err(|_| source_changed());
            registered.and_then(|progress| {
                graph_close?;
                canonical_close?;
                Ok(progress)
            })
        })();
        let released = lease.release(result.is_ok()).map_err(coordination_error);
        result.and_then(|progress| {
            released?;
            Ok(progress)
        })
    })
    .await
    .map_err(join_error)?
}

struct PreparedTypedSource {
    handle: crate::cognition::MemoryGenerationHandle,
    owner: TypedMemoryRecord,
    plan: TypedPlan,
    canonical_path: PathBuf,
    extraction_model: String,
    reasoning_effort: String,
}

fn prepare_typed(
    input: &RegisterTypedSourceInput,
    environment: &CognitionPathEnvironment,
) -> CognitionResult<PreparedTypedSource> {
    let handle = resolve_generation(&input.data_root, environment, &input.target)?;
    ensure_data_authority(
        &input.data_root,
        &[&handle.root, &handle.graph_path, &handle.source_root],
    )?;
    let owner = read_typed_record(
        &handle.source_root,
        &handle.source_root.join("cognition/memory"),
        &input.source_kind,
        &input.record_id,
    )?
    .ok_or_else(source_changed)?;
    if owner.revision != input.revision
        || owner.operation_id != input.operation_id
        || owner.content_hash != input.content_hash
    {
        return Err(source_changed());
    }
    let plan = prepare_typed_source(&owner)?;
    let canonical_path = handle
        .canonical_snapshot_path
        .clone()
        .unwrap_or_else(|| conversation_store_path(&handle.source_root));
    let model = crate::profile::read_profiling_extractor_model(&handle.source_root);
    Ok(PreparedTypedSource {
        handle,
        owner,
        plan,
        canonical_path,
        extraction_model: model.effective_model,
        reasoning_effort: model.reasoning_effort,
    })
}

fn source_changed() -> CognitionError {
    CognitionError::new("memory_source_changed", "memory_source_changed")
}
fn aborted() -> CognitionError {
    CognitionError::new("memory_write_aborted", "memory_write_aborted")
}
