//! Phase orchestration holds the shared Cognition lease only for claim and commit.

mod claims;

use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use super::{
    checkpoint, result,
    types::{
        ActivePhase, Checkpoint, CheckpointError, CheckpointStatus, CycleResult, CycleStatus,
        Phase, PhaseResult, PhaseResultStatus, RateBudget,
    },
};
use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult},
    coordination::{
        CognitionCoordinationHost, CognitionProcessStatus, CognitionWaitClass,
        CognitionWriteAcquire, CognitionWriteCoordinator,
    },
};

pub(crate) struct PhaseError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) metrics: Map<String, Value>,
}

impl PhaseError {
    #[cfg(test)]
    pub(crate) fn unavailable(phase: Phase) -> Self {
        Self {
            code: "consolidation_phase_unavailable",
            message: phase.as_str().into(),
            metrics: Map::new(),
        }
    }
}

pub(crate) trait PhaseExecutor: Send + Sync {
    fn execute<'a>(
        &'a self,
        phase: Phase,
        run_id: &'a str,
        cancellation: &'a CancellationToken,
    ) -> crate::cognition::PhaseExecutionFuture<'a>;
}

pub(crate) trait CycleEventSink: Send + Sync {
    fn record(&self, name: &str, status: &str, dimensions: Value);
}

pub(crate) struct RunCycle {
    pub(crate) run_id: Option<String>,
    pub(crate) resume: bool,
    pub(crate) cancellation: CancellationToken,
    pub(crate) rate_budget: Arc<dyn Fn() -> Option<RateBudget> + Send + Sync>,
}

impl Default for RunCycle {
    fn default() -> Self {
        Self {
            run_id: None,
            resume: false,
            cancellation: CancellationToken::new(),
            rate_budget: Arc::new(|| None),
        }
    }
}

pub(crate) struct CycleService {
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    lock_path: PathBuf,
    coordinator: Arc<CognitionWriteCoordinator>,
    host: Arc<dyn CognitionCoordinationHost>,
    executor: Arc<dyn PhaseExecutor>,
    events: Arc<dyn CycleEventSink>,
    active_claims: Mutex<HashSet<String>>,
}

impl CycleService {
    pub(crate) fn new(
        data_root: PathBuf,
        environment: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
        host: Arc<dyn CognitionCoordinationHost>,
        executor: Arc<dyn PhaseExecutor>,
        events: Arc<dyn CycleEventSink>,
    ) -> Self {
        let lock_path = environment.consolidation_lock(&data_root);
        Self {
            data_root,
            environment,
            lock_path,
            coordinator,
            host,
            executor,
            events,
            active_claims: Mutex::new(HashSet::new()),
        }
    }

    pub(crate) async fn run(&self, input: RunCycle) -> CognitionResult<CycleResult> {
        let run_id = input
            .run_id
            .unwrap_or_else(|| format!("cr_{}", uuid::Uuid::new_v4()));
        // Check path safety before touching any durable state.
        checkpoint::checkpoint_path(&self.data_root, &self.environment(), &run_id)?;
        let started_at = self.host.now_iso();
        let existing = checkpoint::read_checkpoint(&self.data_root, &self.environment(), &run_id)?;
        if !input.resume && existing.is_some() {
            return Err(CognitionError::new(
                "consolidation_checkpoint_changed",
                "Run already exists; use --resume",
            ));
        }
        let mut checkpoint = if input.resume {
            existing.unwrap_or_else(|| Checkpoint::new(&run_id, &started_at))
        } else {
            Checkpoint::new(&run_id, &started_at)
        };
        let mut phases = Vec::new();
        if let Some(budget) = (input.rate_budget)()
            && budget.remaining_ratio < 0.1
        {
            phases.push(rate_phase(
                Phase::Preflight,
                PhaseResultStatus::DeferredRateLimited,
                &budget,
            ));
            let result = result::build_result(
                &self.data_root,
                &self.environment(),
                run_id,
                started_at,
                CycleStatus::DeferredRateLimited,
                phases,
                None,
            )?;
            self.with_lease(Some(&input.cancellation), || {
                result::write_summary(&self.data_root, &self.environment(), &result)
            })
            .await?;
            return Ok(result);
        }
        for (index, phase) in Phase::ALL.iter().copied().enumerate() {
            if checkpoint.completed_phases.contains(&phase) {
                continue;
            }
            if input.cancellation.is_cancelled() {
                return Err(CognitionError::new(
                    "consolidation_aborted",
                    "Consolidation was cancelled",
                ));
            }
            if let Some(budget) = (input.rate_budget)()
                && budget.remaining_ratio < 0.1
            {
                let previous = checkpoint.clone();
                checkpoint.status = CheckpointStatus::PausedRateLimited;
                checkpoint.next_phase_index = index;
                checkpoint.rate_limit_reset_at = budget.reset_at.clone();
                checkpoint.updated_at = self.host.now_iso();
                phases.push(rate_phase(
                    phase,
                    PhaseResultStatus::PausedRateLimited,
                    &budget,
                ));
                let result = result::build_result(
                    &self.data_root,
                    &self.environment(),
                    run_id,
                    started_at,
                    CycleStatus::PausedRateLimited,
                    phases,
                    None,
                )?;
                self.commit_checkpoint(&previous, &checkpoint, Some(&result))
                    .await?;
                self.events.record(
                    "consolidation_cycle_result",
                    "skipped",
                    serde_json::json!({"run_id":result.run_id,"phase_count":result.phases.len(),
                            "error_count":checkpoint.errors.len(),"raw_text_included":false}),
                );
                return Ok(result);
            }
            let nonce = uuid::Uuid::new_v4().to_string();
            let claimed = match self
                .claim(
                    &checkpoint,
                    phase,
                    index,
                    &nonce,
                    input.resume,
                    &input.cancellation,
                )
                .await
            {
                Ok(value) => value,
                Err(error) if error.code == "memory_write_busy" => {
                    phases.push(PhaseResult {
                        phase,
                        status: PhaseResultStatus::Error,
                        metrics: serde_json::json!({"lock_held": true})
                            .as_object()
                            .unwrap()
                            .clone(),
                        error: Some("consolidation lock is held".into()),
                    });
                    return result::build_result(
                        &self.data_root,
                        &self.environment(),
                        run_id,
                        started_at,
                        CycleStatus::LockHeld,
                        phases,
                        None,
                    );
                }
                Err(error) => return Err(error),
            };
            self.active_claims
                .lock()
                .expect("claim set poisoned")
                .insert(nonce.clone());
            let execution = self
                .executor
                .execute(phase, &run_id, &input.cancellation)
                .await;
            let now = self.host.now_iso();
            let mut committed = claimed.clone();
            committed.updated_at = now.clone();
            committed.next_phase_index = index + 1;
            committed.status = CheckpointStatus::Running;
            committed.active_phase = None;
            match execution {
                Ok(metrics) => {
                    phases.push(PhaseResult {
                        phase,
                        status: PhaseResultStatus::Ok,
                        metrics,
                        error: None,
                    });
                    committed.completed_phases.push(phase);
                    for error in &mut committed.errors {
                        if error.phase == phase && error.resolved_at.is_none() {
                            error.resolved_at = Some(now.clone());
                        }
                    }
                }
                Err(error) => {
                    let safe_message = if error.message == error.code {
                        error.code.to_owned()
                    } else {
                        format!("{}: {}", error.code, error.message)
                    };
                    phases.push(PhaseResult {
                        phase,
                        status: PhaseResultStatus::Error,
                        metrics: error.metrics,
                        error: Some(safe_message.clone()),
                    });
                    committed
                        .errors
                        .push(CheckpointError::new(phase, safe_message));
                }
            }
            let commit = self.commit_checkpoint(&claimed, &committed, None).await;
            self.active_claims
                .lock()
                .expect("claim set poisoned")
                .remove(&nonce);
            commit?;
            checkpoint = committed;
        }
        let status = if checkpoint
            .errors
            .iter()
            .any(|error| error.resolved_at.is_none())
        {
            CycleStatus::CompletedWithErrors
        } else {
            CycleStatus::Completed
        };
        let previous = checkpoint.clone();
        checkpoint.status = if status == CycleStatus::Completed {
            CheckpointStatus::Completed
        } else {
            CheckpointStatus::CompletedWithErrors
        };
        checkpoint.next_phase_index = Phase::ALL.len();
        checkpoint.updated_at = self.host.now_iso();
        let result = result::build_result(
            &self.data_root,
            &self.environment(),
            run_id.clone(),
            started_at,
            status,
            phases,
            Some(self.host.now_iso()),
        )?;
        // Final summary and checkpoint are serialized under the same claim authority.
        self.commit_checkpoint(&previous, &checkpoint, Some(&result))
            .await?;
        self.events.record(
            "consolidation_cycle_result",
            if status == CycleStatus::Completed {
                "ok"
            } else {
                "skipped"
            },
            serde_json::json!({"run_id":run_id,"phase_count":result.phases.len(),
                "error_count":checkpoint.errors.len(),"raw_text_included":false}),
        );
        Ok(result)
    }
}

fn rate_phase(phase: Phase, status: PhaseResultStatus, budget: &RateBudget) -> PhaseResult {
    let mut result = PhaseResult::new(phase, status);
    result.metrics = serde_json::json!({
        "remaining_ratio":budget.remaining_ratio,"reset_at":budget.reset_at,
    })
    .as_object()
    .unwrap()
    .clone();
    result
}

#[cfg(test)]
mod tests;
