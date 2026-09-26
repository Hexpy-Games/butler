//! The four source-configured memory maintenance phases and their durable report.

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

pub(crate) type ConfiguredPhaseFuture<'a> =
    Pin<Box<dyn Future<Output = CognitionResult<Value>> + Send + 'a>>;

pub(crate) trait ConfiguredPhaseExecutor: Send + Sync {
    fn run<'a>(
        &'a self,
        phase: ConfiguredPhase,
        deadline_at_epoch_ms: i64,
        cancellation: &'a CancellationToken,
    ) -> ConfiguredPhaseFuture<'a>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ConfiguredPhase {
    Catchup,
    Consolidate,
    Optimize,
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

#[derive(Clone, Debug)]
pub(crate) struct ConfiguredCycleOptions {
    pub enabled: bool,
    pub total_budget_ms: u64,
    pub subphase_budgets_ms: [u64; 4],
    pub activation_decay_d: f64,
    pub project_capsule_refresh_limit: usize,
}

impl ConfiguredCycleOptions {
    pub(crate) fn load(data_root: &std::path::Path) -> Self {
        let raw = std::fs::read(data_root.join("butler.config.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or(Value::Null);
        let config = &raw["cognition"]["consolidationCycle"];
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
            project_capsule_refresh_limit: number("projectCapsuleRefreshLimit", 20)
                .min(usize::MAX as u64) as usize,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ConfiguredCycleResult {
    pub exit_code: u8,
    pub skipped: bool,
    pub phases_run: usize,
    pub aborted: Option<&'static str>,
    pub failed_phases: Vec<&'static str>,
}

impl ConfiguredCycleResult {
    pub(crate) fn skipped() -> Self {
        Self {
            exit_code: 0,
            skipped: true,
            phases_run: 0,
            aborted: None,
            failed_phases: Vec::new(),
        }
    }
}

pub(crate) struct ConfiguredCycleService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    executor: Arc<dyn ConfiguredPhaseExecutor>,
}

impl ConfiguredCycleService {
    pub(crate) fn new(
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

    pub(crate) async fn run(
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
        let deadline = now_ms().saturating_add(config.total_budget_ms.min(i64::MAX as u64) as i64);
        let mut result = ConfiguredCycleResult {
            exit_code: 0,
            skipped: false,
            phases_run: 0,
            aborted: None,
            failed_phases: Vec::new(),
        };
        for (phase_index, phase) in ConfiguredPhase::ALL.into_iter().enumerate() {
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
            // The source records a soft subphase budget but never enforces or emits it.
            let _phase_soft_budget_ms = config.subphase_budgets_ms[phase_index];
            let output = self.executor.run(phase, deadline, cancellation).await;
            let duration = phase_start.elapsed().as_millis().min(u64::MAX as u128) as u64;
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
                    json!({"phase":phase.name(),"status":"error","duration_ms":duration,"error":{"name":error.code,"message":error.code,"stack_tail":""}})
                }
                Err(error) => {
                    result.failed_phases.push(phase.name());
                    json!({"phase":phase.name(),"status":"error","duration_ms":duration,"error":{"name":error.code,"message":error.code,"stack_tail":""}})
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
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

async fn append_event(data_root: PathBuf, root: PathBuf, mut event: Value) -> CognitionResult<()> {
    let now: chrono::DateTime<chrono::Utc> = SystemTime::now().into();
    event["ts"] = json!(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
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
    event["ts"] = json!(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    append(data_root, root.join("run-summary.jsonl"), event).await
}

async fn append(data_root: PathBuf, path: PathBuf, event: Value) -> CognitionResult<()> {
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        ensure_data_authority(&data_root, &[&path])?;
        std::fs::create_dir_all(path.parent().expect("configured event parent"))
            .map_err(log_error)?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(log_error)?;
        writeln!(file, "{}", event).map_err(log_error)?;
        Ok::<(), CognitionError>(())
    })
    .await
    .map_err(|_| {
        CognitionError::new(
            "memory_maintenance_log_failed",
            "memory_maintenance_log_failed",
        )
    })?
}

fn log_error(error: std::io::Error) -> CognitionError {
    CognitionError::new("memory_maintenance_log_failed", error.to_string())
}

#[cfg(test)]
mod tests;
