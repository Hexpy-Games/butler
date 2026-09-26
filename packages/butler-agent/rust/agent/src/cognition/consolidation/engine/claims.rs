//! Short checkpoint claim and commit operations over the shared writer fence.

use super::*;

impl CycleService {
    pub(super) async fn with_lease<T>(
        &self,
        cancellation: Option<&CancellationToken>,
        run: impl FnOnce() -> CognitionResult<T>,
    ) -> CognitionResult<T> {
        let mut request = CognitionWriteAcquire::immediate(self.lock_path.clone(), "consolidation");
        request.cancellation = cancellation.cloned();
        let lease = self
            .coordinator
            .acquire(request, CognitionWaitClass::Background)
            .await
            .map_err(|e| CognitionError::new(e.code, e.message))?
            .ok_or_else(|| {
                CognitionError::new("memory_write_busy", "Consolidation lock is held")
            })?;
        let outcome = run();
        let released = lease
            .release(outcome.is_ok())
            .map_err(|e| CognitionError::new(e.code, e.message));
        match (outcome, released) {
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
            (Ok(value), Ok(())) => Ok(value),
        }
    }

    pub(super) fn environment(&self) -> CognitionPathEnvironment {
        self.environment.clone()
    }

    pub(super) async fn claim(
        &self,
        expected: &Checkpoint,
        phase: Phase,
        index: usize,
        nonce: &str,
        resume: bool,
        cancellation: &CancellationToken,
    ) -> CognitionResult<Checkpoint> {
        self.with_lease(Some(cancellation), || {
            if cancellation.is_cancelled() {
                return Err(CognitionError::new(
                    "consolidation_aborted",
                    "Consolidation was cancelled",
                ));
            }
            let current = checkpoint::read_checkpoint(
                &self.data_root,
                &self.environment(),
                &expected.run_id,
            )?
            .unwrap_or_else(|| expected.clone());
            if let Some(active) = &current.active_phase {
                let same_process = active.owner_pid == self.host.process_id();
                let locally_active =
                    same_process && self.active_claims.lock().contains(&active.owner_nonce);
                let other_active = !same_process
                    && self.host.process_status(u64::from(active.owner_pid))
                        != CognitionProcessStatus::DefinitelyDead;
                if locally_active || other_active {
                    return Err(CognitionError::new(
                        "memory_write_busy",
                        "Consolidation phase is active",
                    ));
                }
            }
            if current != *expected
                || current.completed_phases.contains(&phase)
                || (!resume && current.next_phase_index != index)
            {
                return Err(CognitionError::new(
                    "consolidation_checkpoint_changed",
                    "Checkpoint changed",
                ));
            }
            let mut claimed = current;
            claimed.active_phase = Some(ActivePhase {
                phase,
                owner_pid: self.host.process_id(),
                owner_nonce: nonce.to_owned(),
                started_at: self.host.now_iso(),
            });
            claimed.updated_at = self.host.now_iso();
            checkpoint::write_checkpoint(&self.data_root, &self.environment(), &claimed)?;
            Ok(claimed)
        })
        .await
    }

    pub(super) async fn commit_checkpoint(
        &self,
        expected: &Checkpoint,
        next: &Checkpoint,
        summary: Option<&CycleResult>,
    ) -> CognitionResult<()> {
        self.with_lease(None, || {
            let current = checkpoint::read_checkpoint(
                &self.data_root,
                &self.environment(),
                &expected.run_id,
            )?
            .or_else(|| {
                (expected.next_phase_index == 0 && expected.active_phase.is_none())
                    .then(|| expected.clone())
            })
            .ok_or_else(|| {
                CognitionError::new("consolidation_checkpoint_changed", "Checkpoint missing")
            })?;
            if current != *expected {
                return Err(CognitionError::new(
                    "consolidation_checkpoint_changed",
                    "Checkpoint changed",
                ));
            }
            checkpoint::write_checkpoint(&self.data_root, &self.environment(), next)?;
            if let Some(summary) = summary {
                result::write_summary(&self.data_root, &self.environment(), summary)?;
            }
            Ok(())
        })
        .await
    }
}
