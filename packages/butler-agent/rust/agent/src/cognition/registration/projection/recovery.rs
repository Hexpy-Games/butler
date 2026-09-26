//! Recover interrupted semantic claims before selecting pending work.

use super::*;

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
                "cognition_projection_unconfigured",
                "cognition_projection_unconfigured",
            )
        })?;
        let permit = self
            .admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| closed())?;
        let token = {
            let lifecycle = self.lifecycle.lock().unwrap();
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
        tokio::spawn(async move {
            let _token = token;
            let _permit = permit;
            let lock = environment.consolidation_lock(&data_root);
            let mut request = CognitionWriteAcquire::immediate(lock.clone(), "projection");
            request.cancellation = Some(cancellation.clone());
            let acquired = tokio::select! {
                biased;
                _ = shutdown.cancelled() => Err(write_aborted()),
                _ = cancellation.cancelled() => Err(write_aborted()),
                result = coordinator.acquire(request, CognitionWaitClass::Background) =>
                    result.map_err(coordination_error).and_then(|lease|
                        lease.ok_or_else(|| CognitionError::new("memory_write_busy", "memory_write_busy"))),
            };
            let result = match acquired {
                Err(error) => Err(error),
                Ok(lease) => tokio::task::spawn_blocking(move || {
                    let result = (|| {
                        lease.assert_for_path(&lock).map_err(coordination_error)?;
                        assert_mutation_authority(&data_root, &environment, &target, &handle)?;
                        let mut graph = GraphRepository::open(&handle.graph_path)?;
                        let nonce = host.new_uuid();
                        let now = clock();
                        // Snapshot after the write lease. Claims register their
                        // owner while holding that same lease.
                        let active = active_owners.lock().unwrap().clone();
                        let result = graph.recover_interrupted_semantic(
                            crate::cognition::graph::ClaimProjectionWindowInput {
                                job_id: None,
                                now: &now,
                                owner_pid: host.process_id(),
                                owner_nonce: &nonce,
                                active_owners: &active,
                                process_status: &|pid| host.process_status(pid),
                            },
                        );
                        let closed = graph.close();
                        result.and(closed)
                    })();
                    let released = lease.release(result.is_ok()).map_err(coordination_error);
                    result.and(released)
                })
                .await
                .map_err(join_error)
                .and_then(|result| result),
            };
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
