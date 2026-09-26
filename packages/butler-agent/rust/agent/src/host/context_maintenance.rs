//! Process-owned daily context maintenance. The service starts this after readiness.

use parking_lot::Mutex;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::context::{NativeToolOutput, PruneToolOutputInput};
use crate::operations::MetricFiles;

use super::NativeDateParser;
#[cfg(unix)]
use super::{daily_cognition::DailyCognitionJobs, daily_schedule};

const INTERVAL: Duration = Duration::from_secs(60);
const DUE_MINUTE: u16 = 3 * 60 + 30;
const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1_000.0;

pub(crate) struct ContextMaintenance {
    data_root: PathBuf,
    tool_output: NativeToolOutput,
    metrics: Arc<MetricFiles>,
    timezone: Arc<NativeDateParser>,
    #[cfg(unix)]
    daily_cognition: Arc<DailyCognitionJobs>,
    cancellation: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl ContextMaintenance {
    pub(super) fn new(
        data_root: PathBuf,
        tool_output: NativeToolOutput,
        metrics: Arc<MetricFiles>,
        timezone: Arc<NativeDateParser>,
        #[cfg(unix)] daily_cognition: Arc<DailyCognitionJobs>,
    ) -> Self {
        Self {
            data_root,
            tool_output,
            metrics,
            timezone,
            #[cfg(unix)]
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
        #[cfg(unix)]
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
                            eprintln!("[context-maintenance] {error}");
                        }
                        #[cfg(unix)]
                        {
                            if cancellation.is_cancelled() {
                                break;
                            }
                            if let Err(error) = daily_schedule::run_due(
                                &data_root,
                                "session-sync",
                                &day,
                                minute,
                                now_ms,
                                &cancellation,
                                daily_cognition.session_sync(&cancellation),
                            )
                            .await
                            {
                                eprintln!("[session-sync] {error}");
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
                                eprintln!("[consolidation-cycle] {error}");
                            }
                        }
                    }
                    Err(error) => eprintln!("[context-maintenance] {}", error.code),
                }
                tokio::select! {
                    _ = cancellation.cancelled() => break,
                    _ = tokio::time::sleep(INTERVAL) => {}
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
    tool_output: &NativeToolOutput,
    metrics: &Arc<MetricFiles>,
    now_ms: i64,
    day: &str,
    minute: u16,
) -> Result<bool, String> {
    if !should_run(data_root, day, minute) {
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
            .map_err(|error| error.to_string())?
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
        let metrics = Arc::clone(metrics);
        let retained =
            tokio::task::spawn_blocking(move || metrics.retain(now_ms as f64, 90.0 * DAY_MS))
                .await
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())?;
        Ok::<_, String>((artifacts, retained))
    }
    .await;
    let mut state = json!({
        "lastRunDate": day,
        "lastRunAt": iso_at(now_ms),
        "status": if result.is_ok() { "ok" } else { "error" },
    });
    if let Err(error) = &result {
        state["message"] = Value::String(error.chars().take(500).collect());
    }
    write_state(&state_path, &state).map_err(|error| error.to_string())?;
    result.map(|(artifacts, retained)| {
        println!(
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
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".context-maintenance-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut bytes = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
        bytes.push(b'\n');
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn current_epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as i64)
}

fn iso_at(now_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now_ms).map_or_else(
        || "1970-01-01T00:00:00.000Z".to_owned(),
        |date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_daily_state_skips_success_and_error_until_next_day() {
        let root =
            std::env::temp_dir().join(format!("butler-context-schedule-{}", uuid::Uuid::new_v4()));
        assert!(!should_run(&root, "2026-09-23", 209));
        assert!(should_run(&root, "2026-09-23", 210));
        let path = state_path(&root);
        write_state(
            &path,
            &json!({"lastRunDate":"2026-09-23", "status":"error"}),
        )
        .unwrap();
        assert!(!should_run(&root, "2026-09-23", 210));
        assert!(should_run(&root, "2026-09-24", 210));
        write_state(&path, &json!({"lastRunDate":"2026-09-24", "status":"ok"})).unwrap();
        assert!(!should_run(&root, "2026-09-24", 210));
        std::fs::remove_dir_all(root).unwrap();
    }
}
