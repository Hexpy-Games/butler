//! Phase orchestration holds the shared Cognition lease only for claim and commit.

mod claims;
mod outcome;

use parking_lot::Mutex;
use std::{collections::HashSet, path::PathBuf, sync::Arc};

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use super::{
    checkpoint, result,
    types::{
        ActivePhase, Checkpoint, CheckpointError, CheckpointStatus, CycleResult, CycleStatus,
        Phase, PhaseResult, PhaseResultStatus, RateBudget,
    },
};
use crate::cognition::CognitionCode;
use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult},
    coordination::{
        CognitionCoordinationHost, CognitionProcessStatus, CognitionWaitClass,
        CognitionWriteAcquire, CognitionWriteCoordinator,
    },
};
use outcome::{rate_phase, record_execution};

/// A consolidation phase failed. `code`/`message` are recorded in the
/// checkpoint, `metrics` are the partial phase metrics, and `source` is the
/// underlying error when there was one.
#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub struct PhaseError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    /// Boxed: phase results travel in `Result` and the map is rarely present.
    pub(crate) metrics: Box<Map<String, Value>>,
    #[source]
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl PhaseError {
    /// A phase failure with `code` and `message`.
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            metrics: Box::default(),
            source: None,
        }
    }

    /// Attaches the partial metrics of the failed phase.
    #[must_use]
    pub fn with_metrics(mut self, metrics: Map<String, Value>) -> Self {
        self.metrics = Box::new(metrics);
        self
    }

    /// Records the underlying error.
    #[must_use]
    pub fn with_source(
        mut self,
        source: impl Into<Box<dyn std::error::Error + Send + Sync>>,
    ) -> Self {
        self.source = Some(source.into());
        self
    }

    #[cfg(test)]
    pub(crate) fn unavailable(phase: Phase) -> Self {
        Self::new("consolidation_phase_unavailable", phase.as_str())
    }
}

/// Runs one consolidation phase.
pub trait PhaseExecutor: Send + Sync {
    /// Runs `phase` of run `run_id`; the phase's metrics, or its failure.
    fn execute<'a>(
        &'a self,
        phase: Phase,
        run_id: &'a str,
        cancellation: &'a CancellationToken,
    ) -> crate::cognition::PhaseExecutionFuture<'a>;
}

/// Receives consolidation cycle events.
pub trait CycleEventSink: Send + Sync {
    /// Passthrough: metric dimensions are recorded as given, like every
    /// other cycle metric.
    fn record(&self, name: &str, status: &str, dimensions: Value);
}

/// Consolidation events land in the operations cycle metrics.
impl CycleEventSink for butler_runtime::operations::CycleMetrics {
    /// Passthrough: the dimensions go to the cycle metrics unchanged.
    fn record(&self, name: &str, status: &str, dimensions: Value) {
        Self::record(self, name, status, &dimensions);
    }
}

/// How to run a consolidation cycle.
pub struct RunCycle {
    /// Run id; a new one when absent.
    pub run_id: Option<String>,
    /// Resume an existing run from its checkpoint.
    pub resume: bool,
    /// Stops the cycle when cancelled.
    pub cancellation: CancellationToken,
    /// The model rate budget, checked before each phase.
    pub rate_budget: Arc<dyn Fn() -> Option<RateBudget> + Send + Sync>,
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

/// Runs consolidation cycles phase by phase with a durable checkpoint.
pub struct CycleService {
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
    /// A cycle service over `data_root`.
    pub fn new(
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

    /// Runs (or resumes) a consolidation cycle phase by phase, pausing when
    /// the rate budget runs low and stopping when another writer holds the
    /// lock.
    pub async fn run(&self, input: RunCycle) -> CognitionResult<CycleResult> {
        let run_id = input
            .run_id
            .clone()
            .unwrap_or_else(|| format!("cr_{}", uuid::Uuid::new_v4()));
        // Check path safety before touching any durable state.
        checkpoint::checkpoint_path(&self.data_root, &self.environment(), &run_id)?;
        let started_at = self.host.now_iso();
        let checkpoint = self.starting_checkpoint(&run_id, &started_at, input.resume)?;
        let mut cycle = Cycle {
            run_id,
            started_at,
            phases: Vec::new(),
            checkpoint,
        };
        if let Some(budget) = low_budget(&input) {
            return self.defer(cycle, &budget, &input.cancellation).await;
        }
        for (index, phase) in Phase::ALL.iter().copied().enumerate() {
            if cycle.checkpoint.completed_phases.contains(&phase) {
                continue;
            }
            if input.cancellation.is_cancelled() {
                return Err(CognitionError::new(
                    CognitionCode::ConsolidationAborted,
                    "Consolidation was cancelled",
                ));
            }
            if let Some(budget) = low_budget(&input) {
                return self.pause(cycle, phase, index, &budget).await;
            }
            if self.run_phase(&mut cycle, phase, index, &input).await? == Step::LockHeld {
                return self.lock_held(cycle, phase);
            }
        }
        self.complete(cycle).await
    }

    /// The checkpoint to start from: the stored one when resuming, a fresh
    /// one otherwise (refused when the run already exists).
    fn starting_checkpoint(
        &self,
        run_id: &str,
        started_at: &str,
        resume: bool,
    ) -> CognitionResult<Checkpoint> {
        let existing = checkpoint::read_checkpoint(&self.data_root, &self.environment(), run_id)?;
        if !resume && existing.is_some() {
            return Err(CognitionError::new(
                CognitionCode::ConsolidationCheckpointChanged,
                "Run already exists; use --resume",
            ));
        }
        Ok(if resume {
            existing.unwrap_or_else(|| Checkpoint::new(run_id, started_at))
        } else {
            Checkpoint::new(run_id, started_at)
        })
    }

    /// The whole cycle is deferred before its first phase.
    async fn defer(
        &self,
        cycle: Cycle,
        budget: &RateBudget,
        cancellation: &CancellationToken,
    ) -> CognitionResult<CycleResult> {
        let mut phases = cycle.phases;
        phases.push(rate_phase(
            Phase::Preflight,
            PhaseResultStatus::DeferredRateLimited,
            budget,
        ));
        let result = result::build_result(
            &self.data_root,
            &self.environment(),
            cycle.run_id,
            cycle.started_at,
            CycleStatus::DeferredRateLimited,
            phases,
            None,
        )?;
        self.with_lease(Some(cancellation), || {
            result::write_summary(&self.data_root, &self.environment(), &result)
        })
        .await?;
        Ok(result)
    }

    /// The cycle pauses before `phase`, to resume there once the rate
    /// budget recovers.
    async fn pause(
        &self,
        cycle: Cycle,
        phase: Phase,
        index: usize,
        budget: &RateBudget,
    ) -> CognitionResult<CycleResult> {
        let Cycle {
            run_id,
            started_at,
            mut phases,
            checkpoint: previous,
        } = cycle;
        let mut checkpoint = previous.clone();
        checkpoint.status = CheckpointStatus::PausedRateLimited;
        checkpoint.next_phase_index = index;
        checkpoint.rate_limit_reset_at = budget.reset_at.clone();
        checkpoint.updated_at = self.host.now_iso();
        phases.push(rate_phase(
            phase,
            PhaseResultStatus::PausedRateLimited,
            budget,
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
        self.record_result(&result.run_id, &result, &checkpoint, "skipped");
        Ok(result)
    }

    /// Claims, executes and commits one phase.
    async fn run_phase(
        &self,
        cycle: &mut Cycle,
        phase: Phase,
        index: usize,
        input: &RunCycle,
    ) -> CognitionResult<Step> {
        let nonce = uuid::Uuid::new_v4().to_string();
        let claimed = match self
            .claim(
                &cycle.checkpoint,
                phase,
                index,
                &nonce,
                input.resume,
                &input.cancellation,
            )
            .await
        {
            Ok(value) => value,
            Err(error) if error.code() == "memory_write_busy" => return Ok(Step::LockHeld),
            Err(error) => return Err(error),
        };
        self.active_claims.lock().insert(nonce.clone());
        let execution = self
            .executor
            .execute(phase, &cycle.run_id, &input.cancellation)
            .await;
        let now = self.host.now_iso();
        let mut committed = claimed.clone();
        committed.updated_at = now.clone();
        committed.next_phase_index = index + 1;
        committed.status = CheckpointStatus::Running;
        committed.active_phase = None;
        cycle
            .phases
            .push(record_execution(&mut committed, phase, execution, &now));
        let commit = self.commit_checkpoint(&claimed, &committed, None).await;
        self.active_claims.lock().remove(&nonce);
        commit?;
        cycle.checkpoint = committed;
        Ok(Step::Committed)
    }

    /// The result when another writer holds the consolidation lock.
    fn lock_held(&self, cycle: Cycle, phase: Phase) -> CognitionResult<CycleResult> {
        let mut phases = cycle.phases;
        phases.push(PhaseResult {
            phase,
            status: PhaseResultStatus::Error,
            metrics: butler_core::json::json_object!({"lock_held": true}),
            error: Some("consolidation lock is held".into()),
        });
        result::build_result(
            &self.data_root,
            &self.environment(),
            cycle.run_id,
            cycle.started_at,
            CycleStatus::LockHeld,
            phases,
            None,
        )
    }

    /// Commits the final checkpoint and summary once every phase ran.
    async fn complete(&self, cycle: Cycle) -> CognitionResult<CycleResult> {
        let Cycle {
            run_id,
            started_at,
            phases,
            checkpoint: previous,
        } = cycle;
        let status = if previous
            .errors
            .iter()
            .any(|error| error.resolved_at.is_none())
        {
            CycleStatus::CompletedWithErrors
        } else {
            CycleStatus::Completed
        };
        let mut checkpoint = previous.clone();
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
        let outcome = if status == CycleStatus::Completed {
            "ok"
        } else {
            "skipped"
        };
        self.record_result(&run_id, &result, &checkpoint, outcome);
        Ok(result)
    }

    fn record_result(
        &self,
        run_id: &str,
        result: &CycleResult,
        checkpoint: &Checkpoint,
        outcome: &str,
    ) {
        let event = CycleResultEvent {
            run_id,
            phase_count: result.phases.len(),
            error_count: checkpoint.errors.len(),
            raw_text_included: false,
        };
        self.events.record(
            "consolidation_cycle_result",
            outcome,
            serde_json::to_value(event).unwrap_or_default(),
        );
    }
}

/// A cycle in progress: its identity, the phase results so far and the
/// checkpoint as last committed.
struct Cycle {
    run_id: String,
    started_at: String,
    phases: Vec<PhaseResult>,
    checkpoint: Checkpoint,
}

/// How a phase attempt ended.
#[derive(PartialEq, Eq)]
enum Step {
    Committed,
    LockHeld,
}

/// Dimensions of the `consolidation_cycle_result` event.
#[derive(serde::Serialize)]
struct CycleResultEvent<'a> {
    run_id: &'a str,
    phase_count: usize,
    error_count: usize,
    raw_text_included: bool,
}

/// The rate budget, when it is too low to start another phase.
fn low_budget(input: &RunCycle) -> Option<RateBudget> {
    (input.rate_budget)().filter(|budget| budget.remaining_ratio < 0.1)
}

#[cfg(test)]
mod tests;
