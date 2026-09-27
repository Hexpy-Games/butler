//! The four source-configured memory maintenance phases and their durable report.

use crate::lenient::JsonField;
use crate::lenient::set_field;
use std::{
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    CognitionError, CognitionPathEnvironment, CognitionResult, active_memory_descriptor_exists,
    mutable_paths::ensure_data_authority,
};
use crate::cognition::CognitionCode;

/// The pending result of one configured phase.
pub type ConfiguredPhaseFuture<'a> =
    Pin<Box<dyn Future<Output = CognitionResult<Value>> + Send + 'a>>;

/// Runs the phases of the configured consolidation cycle.
pub trait ConfiguredPhaseExecutor: Send + Sync {
    /// Runs `phase`; its metrics, or the failure.
    fn run<'a>(
        &'a self,
        phase: ConfiguredPhase,
        deadline_at_epoch_ms: i64,
        cancellation: &'a CancellationToken,
    ) -> ConfiguredPhaseFuture<'a>;
}

/// Phases of the configured cycle, in run order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfiguredPhase {
    /// Catch up on unprojected conversation sources.
    Catchup,
    /// Consolidate memory.
    Consolidate,
    /// Optimize the vector store.
    Optimize,
    /// Record memory health.
    Health,
}

impl ConfiguredPhase {
    const ALL: [Self; 4] = [
        Self::Catchup,
        Self::Consolidate,
        Self::Optimize,
        Self::Health,
    ];
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Catchup => "catchup",
            Self::Consolidate => "consolidate",
            Self::Optimize => "optimize",
            Self::Health => "health",
        }
    }
}

/// The configured cycle settings from `butler.config.json`.
#[derive(Clone, Debug)]
pub struct ConfiguredCycleOptions {
    /// Whether the cycle runs.
    pub enabled: bool,
    /// Time budget for the whole cycle, in milliseconds.
    pub total_budget_ms: u64,
    /// Parsed for parity with the source config, which records these soft
    /// subphase budgets but never enforces or emits them.
    pub subphase_budgets_ms: [u64; 4],
    /// Activation decay applied by consolidation.
    pub activation_decay_d: f64,
    /// Project capsules refreshed per cycle at most.
    pub project_capsule_refresh_limit: usize,
}

impl ConfiguredCycleOptions {
    /// The settings in `data_root`, with defaults for anything missing.
    pub fn load(data_root: &std::path::Path) -> Self {
        let raw = std::fs::read(data_root.join("butler.config.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or(Value::Null);
        let config = &raw.field("cognition").field("consolidationCycle");
        let number = |key: &str, default| config[key].as_u64().unwrap_or(default);
        let sub = &config["subPhaseBudgetsMs"];
        Self {
            enabled: config["enabled"] != false,
            total_budget_ms: number("totalBudgetMs", 600_000),
            subphase_budgets_ms: [
                sub["catchup"].as_u64().unwrap_or(120_000),
                sub["consolidate"].as_u64().unwrap_or(240_000),
                sub["optimize"].as_u64().unwrap_or(180_000),
                sub["health"].as_u64().unwrap_or(60_000),
            ],
            activation_decay_d: config["activationDecayD"].as_f64().unwrap_or(0.5),
            project_capsule_refresh_limit: usize::try_from(
                number("projectCapsuleRefreshLimit", 20).min(usize::MAX as u64),
            )
            .unwrap_or(usize::MAX),
        }
    }
}

/// Outcome of a configured cycle.
#[derive(Clone, Debug)]
pub struct ConfiguredCycleResult {
    /// Process exit code for the CLI.
    pub exit_code: u8,
    /// The cycle did not run (disabled, or no active memory).
    pub skipped: bool,
    /// Phases that ran.
    pub phases_run: usize,
    /// Why the cycle stopped early, when it did.
    pub aborted: Option<&'static str>,
    /// Phases that failed.
    pub failed_phases: Vec<&'static str>,
}

impl ConfiguredCycleResult {
    /// The result of a cycle that did not run.
    pub fn skipped() -> Self {
        Self {
            exit_code: 0,
            skipped: true,
            phases_run: 0,
            aborted: None,
            failed_phases: Vec::new(),
        }
    }
}

/// Runs the configured consolidation cycle within its time budget.
pub struct ConfiguredCycleService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    executor: Arc<dyn ConfiguredPhaseExecutor>,
}

impl ConfiguredCycleService {
    /// A cycle service over `data_root`.
    pub fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        executor: Arc<dyn ConfiguredPhaseExecutor>,
    ) -> Self {
        Self {
            data_root,
            paths,
            executor,
        }
    }

    /// Runs every phase in order unless the cycle is disabled, cancelled or out of budget.
    pub async fn run(
        &self,
        config: &ConfiguredCycleOptions,
        cancellation: &CancellationToken,
    ) -> CognitionResult<ConfiguredCycleResult> {
        if !config.enabled || !active_memory_descriptor_exists(&self.data_root, &self.paths)? {
            return Ok(ConfiguredCycleResult::skipped());
        }
        let root = self
            .paths
            .cognition_root(&self.data_root)
            .join("consolidation");
        ensure_data_authority(&self.data_root, &[&root])?;
        let start = Instant::now();
        let deadline = now_ms().saturating_add(
            i64::try_from(config.total_budget_ms.min(i64::MAX as u64)).unwrap_or(i64::MAX),
        );
        let mut result = ConfiguredCycleResult {
            exit_code: 0,
            skipped: false,
            phases_run: 0,
            aborted: None,
            failed_phases: Vec::new(),
        };
        for phase in ConfiguredPhase::ALL {
            if cancellation.is_cancelled() {
                result.aborted = Some("cancelled");
                result.exit_code = 1;
                break;
            }
            if now_ms() >= deadline {
                result.aborted = Some("aborted_budget");
                break;
            }
            let phase_start = Instant::now();
            let output = self.executor.run(phase, deadline, cancellation).await;
            let duration =
                u64::try_from(phase_start.elapsed().as_millis().min(u128::from(u64::MAX)))
                    .unwrap_or(u64::MAX);
            let event = match output {
                Ok(_) if now_ms() >= deadline => {
                    result.aborted = Some("aborted_budget");
                    json!({"phase":phase.name(),"status":"aborted_budget","duration_ms":duration})
                }
                Ok(metrics) => {
                    result.phases_run += 1;
                    json!({"phase":phase.name(),"status":"ok","duration_ms":duration,"metrics":metrics})
                }
                Err(error) if cancellation.is_cancelled() => {
                    result.aborted = Some("cancelled");
                    result.exit_code = 1;
                    json!({"phase":phase.name(),"status":"error","duration_ms":duration,"error":{"name":error.code(),"message":error.code(),"stack_tail":""}})
                }
                Err(error) => {
                    result.failed_phases.push(phase.name());
                    json!({"phase":phase.name(),"status":"error","duration_ms":duration,"error":{"name":error.code(),"message":error.code(),"stack_tail":""}})
                }
            };
            append_event(self.data_root.clone(), root.clone(), event).await?;
            if result.aborted.is_some() {
                break;
            }
        }
        let status = result
            .aborted
            .unwrap_or(if result.failed_phases.is_empty() {
                "ok"
            } else {
                "error"
            });
        append_summary(self.data_root.clone(), root, json!({"phase":"summary","status":status,"duration_ms":start.elapsed().as_millis(),"metrics":{"phases_run":result.phases_run,"aborted":result.aborted==Some("aborted_budget"),"failed_phases":&result.failed_phases}})).await?;
        Ok(result)
    }
}

fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128),
    )
    .unwrap_or(i64::MAX)
}

async fn append_event(data_root: PathBuf, root: PathBuf, mut event: Value) -> CognitionResult<()> {
    let now: chrono::DateTime<chrono::Utc> = SystemTime::now().into();
    set_field(
        &mut event,
        "ts",
        json!(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    let path = root.join("logs").join(format!(
        "consolidation-cycle-{}.jsonl",
        now.format("%Y-%m-%d")
    ));
    append(data_root, path, event).await
}

async fn append_summary(
    data_root: PathBuf,
    root: PathBuf,
    mut event: Value,
) -> CognitionResult<()> {
    let now: chrono::DateTime<chrono::Utc> = SystemTime::now().into();
    set_field(
        &mut event,
        "ts",
        json!(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    append(data_root, root.join("run-summary.jsonl"), event).await
}

async fn append(data_root: PathBuf, path: PathBuf, event: Value) -> CognitionResult<()> {
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        ensure_data_authority(&data_root, &[&path])?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(log_error)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(log_error)?;
        writeln!(file, "{event}").map_err(log_error)?;
        Ok::<(), CognitionError>(())
    })
    .await
    .map_err(|source| {
        CognitionError::new(
            CognitionCode::MemoryMaintenanceLogFailed,
            "memory_maintenance_log_failed",
        )
        .with_source(source)
    })?
}

fn log_error(error: std::io::Error) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryMaintenanceLogFailed, error.to_string())
        .with_source(error)
}

#[cfg(test)]
mod tests;
