//! Lease-bound consumption of superseded or forgotten typed-source notices.

use std::{path::PathBuf, sync::Arc};

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::ConsumeTypedLifecycleInput;
use super::{CognitionRegistrationService, closed, join_error};
use crate::cognition::CognitionCode;
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
        receiver.await.map_err(|source| {
            CognitionError::new(
                CognitionCode::MemoryRegistrationOperationFailed,
                "memory_registration_operation_failed",
            )
            .with_source(source)
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
    if run.disposition == TypedMemoryLifecycle::Current
        || run.shutdown.is_cancelled()
        || run.cancellation.is_cancelled()
    {
        return Err(source_changed());
    }
    let lock = run.environment.consolidation_lock(&run.data_root);
    let cognition_root = run.environment.cognition_root(&run.data_root);
    ensure_data_authority(&run.data_root, &[&lock, &cognition_root])?;
    let acquisition = run.coordinator.acquire(
        CognitionWriteAcquire {
            lock_path: lock.clone(),
            purpose: Some("typed_lifecycle".into()),
            deadline_at_epoch_ms: None,
            cancellation: Some(run.cancellation.clone()),
        },
        CognitionWaitClass::Background,
    );
    let lease = tokio::select! {
        biased;
        () = run.shutdown.cancelled() => return Err(aborted()),
        () = run.cancellation.cancelled() => return Err(aborted()),
        acquired = acquisition => acquired.map_err(CognitionError::from)?.ok_or_else(aborted)?,
    };
    tokio::task::spawn_blocking(move || {
        let result = run.consume(&lease, &lock);
        let released = lease.release(result.is_ok()).map_err(CognitionError::from);
        result.and(released)
    })
    .await
    .map_err(join_error)?
}

impl TypedLifecycleRun {
    /// Consumes the lifecycle change in the graph, provided the expected
    /// generation is still active and the record still has this lifecycle.
    fn consume(
        &self,
        lease: &crate::coordination::CognitionWriteLease,
        lock: &std::path::Path,
    ) -> CognitionResult<()> {
        lease.assert_for_path(lock).map_err(CognitionError::from)?;
        if self.shutdown.is_cancelled() || self.cancellation.is_cancelled() {
            return Err(aborted());
        }
        let current = self.current_generation()?;
        if read_typed_memory_lifecycle(
            &current.source_root,
            &current.source_root.join("cognition/memory"),
            &self.source_kind,
            &self.record_id,
            &self.operation_id,
            &self.revision,
        )? != Some(self.disposition)
        {
            return Err(source_changed());
        }
        let mut graph = GraphRepository::open(&current.graph_path)?;
        let now = (self.clock)();
        let consumed = graph.consume_typed_lifecycle(TypedLifecycleInput {
            source_kind: &self.source_kind,
            record_id: &self.record_id,
            revision: &self.revision,
            operation_id: &self.operation_id,
            disposition: self.disposition,
            now: &now,
        });
        let closed = graph.close();
        consumed.and(closed)
    }

    /// The active generation, when it is still the expected one.
    fn current_generation(&self) -> CognitionResult<crate::cognition::MemoryGenerationHandle> {
        let target = MemoryGenerationTarget::Active {
            expected_generation: self.expected_generation.clone(),
        };
        let current = resolve_generation(&self.data_root, &self.environment, &target)?;
        assert_mutation_authority(&self.data_root, &self.environment, &target, &current)?;
        let expected_root = self
            .environment
            .memory_root(&self.data_root)
            .join("generations")
            .join(&self.expected_generation);
        if current.generation_id != self.expected_generation || current.root != expected_root {
            return Err(source_changed());
        }
        ensure_data_authority(
            &self.data_root,
            &[&current.root, &current.graph_path, &current.source_root],
        )?;
        if !current.graph_path.is_file() {
            return Err(source_changed());
        }
        Ok(current)
    }
}

fn source_changed() -> CognitionError {
    CognitionError::new(CognitionCode::MemorySourceChanged, "memory_source_changed")
}

fn aborted() -> CognitionError {
    CognitionError::new(CognitionCode::MemoryWriteAborted, "memory_write_aborted")
}
