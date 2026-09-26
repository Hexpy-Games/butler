//! Lease-bound consumption of superseded or forgotten typed-source notices.

use std::{path::PathBuf, sync::Arc};

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::ConsumeTypedLifecycleInput;
use super::{CognitionRegistrationService, closed, coordination_error, join_error};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationTarget,
        assert_mutation_authority, ensure_data_authority,
        graph::{GraphRepository, TypedLifecycleInput},
        resolve_generation,
        sources::{TypedMemoryLifecycle, read_typed_memory_lifecycle},
    },
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

impl CognitionRegistrationService {
    pub(in crate::cognition) async fn consume_typed_lifecycle(
        &self,
        input: ConsumeTypedLifecycleInput,
    ) -> CognitionResult<()> {
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
            let result = run(TypedLifecycleRun {
                data_root: input.data_root,
                expected_generation: input.expected_generation,
                source_kind: input.source_kind,
                record_id: input.record_id,
                revision: input.revision,
                operation_id: input.operation_id,
                disposition: input.disposition,
                cancellation: input.cancellation,
                environment,
                coordinator,
                clock,
                shutdown,
            })
            .await;
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

struct TypedLifecycleRun {
    data_root: PathBuf,
    expected_generation: String,
    source_kind: String,
    record_id: String,
    revision: String,
    operation_id: String,
    disposition: TypedMemoryLifecycle,
    cancellation: CancellationToken,
    environment: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    clock: Arc<dyn Fn() -> String + Send + Sync>,
    shutdown: CancellationToken,
}

async fn run(run: TypedLifecycleRun) -> CognitionResult<()> {
    let TypedLifecycleRun {
        data_root,
        expected_generation,
        source_kind,
        record_id,
        revision,
        operation_id,
        disposition,
        cancellation,
        environment,
        coordinator,
        clock,
        shutdown,
    } = run;
    if disposition == TypedMemoryLifecycle::Current
        || shutdown.is_cancelled()
        || cancellation.is_cancelled()
    {
        return Err(source_changed());
    }
    let lock = environment.consolidation_lock(&data_root);
    let cognition_root = environment.cognition_root(&data_root);
    ensure_data_authority(&data_root, &[&lock, &cognition_root])?;
    let acquisition = coordinator.acquire(
        CognitionWriteAcquire {
            lock_path: lock.clone(),
            purpose: Some("typed_lifecycle".into()),
            deadline_at_epoch_ms: None,
            cancellation: Some(cancellation.clone()),
        },
        CognitionWaitClass::Background,
    );
    let lease = tokio::select! {
        biased;
        () = shutdown.cancelled() => return Err(aborted()),
        () = cancellation.cancelled() => return Err(aborted()),
        acquired = acquisition => acquired.map_err(coordination_error)?.ok_or_else(aborted)?,
    };
    tokio::task::spawn_blocking(move || {
        let result = (|| {
            lease.assert_for_path(&lock).map_err(coordination_error)?;
            if shutdown.is_cancelled() || cancellation.is_cancelled() {
                return Err(aborted());
            }
            let target = MemoryGenerationTarget::Active {
                expected_generation: expected_generation.clone(),
            };
            let current = resolve_generation(&data_root, &environment, &target)?;
            assert_mutation_authority(&data_root, &environment, &target, &current)?;
            let expected_root = environment
                .memory_root(&data_root)
                .join("generations")
                .join(&expected_generation);
            if current.generation_id != expected_generation || current.root != expected_root {
                return Err(source_changed());
            }
            ensure_data_authority(
                &data_root,
                &[&current.root, &current.graph_path, &current.source_root],
            )?;
            if !current.graph_path.is_file() {
                return Err(source_changed());
            }
            if read_typed_memory_lifecycle(
                &current.source_root,
                &current.source_root.join("cognition/memory"),
                &source_kind,
                &record_id,
                &operation_id,
                &revision,
            )? != Some(disposition)
            {
                return Err(source_changed());
            }
            let mut graph = GraphRepository::open(&current.graph_path)?;
            let now = clock();
            let consumed = graph.consume_typed_lifecycle(TypedLifecycleInput {
                source_kind: &source_kind,
                record_id: &record_id,
                revision: &revision,
                operation_id: &operation_id,
                disposition,
                now: &now,
            });
            let closed = graph.close();
            consumed.and(closed)
        })();
        let released = lease.release(result.is_ok()).map_err(coordination_error);
        result.and(released)
    })
    .await
    .map_err(join_error)?
}

fn source_changed() -> CognitionError {
    CognitionError::new("memory_source_changed", "memory_source_changed")
}

fn aborted() -> CognitionError {
    CognitionError::new("memory_write_aborted", "memory_write_aborted")
}
