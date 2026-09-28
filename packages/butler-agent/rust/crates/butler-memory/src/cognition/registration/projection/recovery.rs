//! Recover interrupted semantic claims before selecting pending work.

use super::*;
use crate::cognition::CognitionCode;

impl CognitionRegistrationService {
    /// Run the same interrupted-window recovery as a claim before the idle
    /// selector inspects pending work. A crash-held `running` row is otherwise
    /// invisible to that selector.
    pub(crate) async fn recover_semantic_windows(
        &self,
        data_root: PathBuf,
        handle: MemoryGenerationHandle,
        target: MemoryGenerationTarget,
        cancellation: CancellationToken,
    ) -> CognitionResult<()> {
        let deps = self.projection.as_ref().ok_or_else(|| {
            CognitionError::new(
                CognitionCode::CognitionProjectionUnconfigured,
                "cognition_projection_unconfigured",
            )
        })?;
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
        let host = deps.host.clone();
        let active_owners = self.active_windows.clone();
        let (sender, receiver) = oneshot::channel();
        // Detached on purpose: the operation token/guard moved into the task keeps the
        // owner's close waiting for it, and the result returns through the oneshot,
        // so a cancelled caller cannot abandon the operation midway.
        tokio::spawn(async move {
            let _token = token;
            let _permit = permit;
            let lock = environment.consolidation_lock(&data_root);
            let mut request = CognitionWriteAcquire::immediate(lock.clone(), "projection");
            request.cancellation = Some(cancellation.clone());
            let acquired = tokio::select! {
                biased;
                () = shutdown.cancelled() => Err(write_aborted()),
                () = cancellation.cancelled() => Err(write_aborted()),
                result = coordinator.acquire(request, CognitionWaitClass::Background) =>
                    result.map_err(CognitionError::from).and_then(|lease|
                        lease.ok_or_else(|| CognitionError::new(CognitionCode::MemoryWriteBusy, "memory_write_busy"))),
            };
            let recovery = Recovery {
                data_root,
                handle,
                target,
                environment,
                host,
                clock,
                active_owners,
            };
            let result = match acquired {
                Err(error) => Err(error),
                Ok(lease) => tokio::task::spawn_blocking(move || {
                    let result = recovery.run(&lease, &lock);
                    let released = lease.release(result.is_ok()).map_err(CognitionError::from);
                    result.and(released)
                })
                .await
                .map_err(join_error)
                .and_then(|result| result),
            };
            let _ = sender.send(result);
        });
        receiver.await.map_err(|source| {
            CognitionError::new(
                CognitionCode::MemoryProjectionOperationFailed,
                "memory_projection_operation_failed",
            )
            .with_source(source)
        })?
    }
}

/// Interrupted-window recovery of one generation, run under the lease.
struct Recovery {
    data_root: PathBuf,
    handle: MemoryGenerationHandle,
    target: MemoryGenerationTarget,
    environment: CognitionPathEnvironment,
    host: Arc<dyn CognitionCoordinationHost>,
    clock: Clock,
    active_owners: ActiveProjectionWindowOwners,
}

impl Recovery {
    fn run(
        &self,
        lease: &crate::coordination::CognitionWriteLease,
        lock: &std::path::Path,
    ) -> CognitionResult<()> {
        lease.assert_for_path(lock).map_err(CognitionError::from)?;
        assert_mutation_authority(
            &self.data_root,
            &self.environment,
            &self.target,
            &self.handle,
        )?;
        let mut graph = GraphRepository::open(&self.handle.graph_path)?;
        let nonce = self.host.new_uuid();
        let now = (self.clock)();
        // Snapshot after the write lease. Claims register their owner while
        // holding that same lease.
        let active = self.active_owners.lock().clone();
        let result = graph.recover_interrupted_semantic(
            crate::cognition::graph::ClaimProjectionWindowInput {
                job_id: None,
                now: &now,
                owner_pid: self.host.process_id(),
                owner_nonce: &nonce,
                active_owners: &active,
                process_status: &|pid| self.host.process_status(pid),
            },
        );
        let closed = graph.close();
        result.and(closed)
    }
}
