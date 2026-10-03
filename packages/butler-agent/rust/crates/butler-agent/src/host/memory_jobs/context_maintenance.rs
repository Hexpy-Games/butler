//! Process-owned daily context maintenance. The service starts this after readiness.

use parking_lot::Mutex;
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use butler_runtime::context::{PruneToolOutputInput, ToolOutput};
use butler_runtime::operations::MetricFiles;

use crate::host::DateParser;
use crate::host::memory_jobs::daily::DailyCognitionJobs;
use crate::host::memory_jobs::daily_schedule;

const INTERVAL: Duration = Duration::from_secs(60);
const DUE_MINUTE: u16 = 3 * 60 + 30;
const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1_000.0;

pub(crate) struct ContextMaintenance {
    data_root: PathBuf,
    tool_output: ToolOutput,
    metrics: Arc<MetricFiles>,
    timezone: Arc<DateParser>,
    daily_cognition: Arc<DailyCognitionJobs>,
    cancellation: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl ContextMaintenance {
    pub(in crate::host) fn for_cognition(
        data: &std::path::Path,
        output: &ToolOutput,
        metrics: &Arc<MetricFiles>,
        timezone: &Arc<DateParser>,
        daily: &Arc<DailyCognitionJobs>,
    ) -> Arc<Self> {
        Arc::new(Self::new(
            data.to_owned(),
            output.clone(),
            metrics.clone(),
            timezone.clone(),
            daily.clone(),
        ))
    }

    pub(in crate::host) fn new(
        data_root: PathBuf,
        tool_output: ToolOutput,
        metrics: Arc<MetricFiles>,
        timezone: Arc<DateParser>,
        daily_cognition: Arc<DailyCognitionJobs>,
    ) -> Self {
        Self {
            data_root,
            tool_output,
            metrics,
            timezone,
            daily_cognition,
            cancellation: CancellationToken::new(),
            task: Mutex::new(None),
        }
    }

    pub(crate) fn start(&self) {
        let mut task = self.task.lock();
        if task.is_some() || self.cancellation.is_cancelled() {
            return;
        }
        let data_root = self.data_root.clone();
        let tool_output = self.tool_output.clone();
        let metrics = Arc::clone(&self.metrics);
        let timezone = Arc::clone(&self.timezone);
        let daily_cognition = Arc::clone(&self.daily_cognition);
        let cancellation = self.cancellation.clone();
        *task = Some(tokio::spawn(async move {
            loop {
                if cancellation.is_cancelled() {
                    break;
                }
                let now_ms = current_epoch_millis();
                match timezone.local_day_and_minute(now_ms) {
                    Ok((day, minute)) => {
                        if cancellation.is_cancelled() {
                            break;
                        }
                        if let Err(error) =
                            run_tick(&data_root, &tool_output, &metrics, now_ms, &day, minute).await
                        {
                            butler_core::diagnostic!("[context-maintenance] {error}");
                        }
                        {
                            if cancellation.is_cancelled() {
                                break;
                            }
                            if let Err(error) = Box::pin(daily_schedule::run_due(
                                &data_root,
                                "session-sync",
                                &day,
                                minute,
                                now_ms,
                                &cancellation,
                                daily_cognition.session_sync(&cancellation),
                            ))
                            .await
                            {
                                butler_core::diagnostic!("[session-sync] {error}");
                            }
                            if cancellation.is_cancelled() {
                                break;
                            }
                            if let Err(error) = daily_schedule::run_due(
                                &data_root,
                                "consolidation-cycle",
                                &day,
                                minute,
                                now_ms,
                                &cancellation,
                                daily_cognition.consolidation_cycle(&cancellation),
                            )
                            .await
                            {
                                butler_core::diagnostic!("[consolidation-cycle] {error}");
                            }
                        }
                    }
                    Err(error) => {
                        butler_core::diagnostic!("[context-maintenance] {}", error.code());
                    }
                }
                tokio::select! {
                    () = cancellation.cancelled() => break,
                    () = tokio::time::sleep(INTERVAL) => {}
                }
            }
        }));
    }

    pub(crate) async fn close(&self) {
        self.cancellation.cancel();
        let task = self.task.lock().take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}

pub(crate) async fn run_tick(
    data_root: &std::path::Path,
    tool_output: &ToolOutput,
    metrics: &Arc<MetricFiles>,
    now_ms: i64,
    day: &str,
    minute: u16,
) -> Result<bool, crate::host::HostError> {
    let root = data_root.to_path_buf();
    let local_day = day.to_owned();
    let due = tokio::task::spawn_blocking(move || should_run(&root, &local_day, minute))
        .await
        .map_err(crate::host::HostError::from_error)?;
    if !due {
        return Ok(false);
    }
    let state_path = state_path(data_root);
    let result = async {
        let artifacts = tool_output
            .submit_prune(PruneToolOutputInput {
                max_age_ms: Some(30.0 * DAY_MS),
                max_bytes: Some(512.0 * 1024.0 * 1024.0),
                protected_paths: Vec::new(),
                record_telemetry: true,
            })
            .await
            .map_err(crate::host::HostError::from_error)?
            .await
            .map_err(crate::host::HostError::from_error)?
            .map_err(crate::host::HostError::from_error)?;
        let metrics = Arc::clone(metrics);
        let retained =
            tokio::task::spawn_blocking(move || metrics.retain(now_ms as f64, 90.0 * DAY_MS))
                .await
                .map_err(crate::host::HostError::from_error)?
                .map_err(crate::host::HostError::from_error)?;
        Ok::<_, crate::host::HostError>((artifacts, retained))
    }
    .await;
    let mut state = json!({
        "lastRunDate": day,
        "lastRunAt": iso_at(now_ms),
        "status": if result.is_ok() { "ok" } else { "error" },
    });
    if let Err(error) = &result {
        state["message"] = Value::String(error.message().chars().take(500).collect());
    }
    tokio::task::spawn_blocking(move || write_state(&state_path, &state))
        .await
        .map_err(crate::host::HostError::from_error)?
        .map_err(crate::host::HostError::from_error)?;
    result.map(|(artifacts, retained)| {
        butler_core::diagnostic!(
            "[context-maintenance] artifacts scanned={} deleted={} bytesDeleted={} remainingBytes={} metrics scanned={} kept={} deleted={} parseErrors={}",
            artifacts.scanned,
            artifacts.deleted,
            artifacts.bytes_deleted,
            artifacts.remaining_bytes,
            retained.totals.scanned,
            retained.totals.kept,
            retained.totals.deleted,
            retained.totals.parse_errors,
        );
        true
    })
}

fn state_path(data_root: &std::path::Path) -> PathBuf {
    data_root.join("state/scheduler/context-maintenance.json")
}

fn should_run(data_root: &std::path::Path, day: &str, minute: u16) -> bool {
    if minute < DUE_MINUTE {
        return false;
    }
    let state_path = state_path(data_root);
    if fs::read(&state_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|state| state["lastRunDate"].as_str().map(str::to_owned))
        .as_deref()
        == Some(day)
    {
        return false;
    }
    true
}

fn write_state(path: &std::path::Path, state: &Value) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "state path has no parent")
    })?;
    butler_platform::secure_fs::create_private_dir_all(parent)?;
    let mut bytes = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    butler_platform::secure_fs::replace_private(
        path,
        |file| file.write_all(&bytes),
        std::convert::identity,
    )
}

fn current_epoch_millis() -> i64 {
    // Daily jobs and App fixtures must share the same clock in stub E2E.
    if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && let Ok(now) = chrono::DateTime::parse_from_rfc3339(
            &crate::host::app::schedule_clock::clock().now_iso(),
        )
    {
        return now.timestamp_millis();
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| {
            i64::try_from(time.as_millis()).unwrap_or(i64::MAX)
        })
}

fn iso_at(now_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now_ms).map_or_else(
        || "1970-01-01T00:00:00.000Z".to_owned(),
        |date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}
