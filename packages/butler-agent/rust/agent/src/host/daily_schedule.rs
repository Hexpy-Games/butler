//! Source-compatible local-day markers for the two 04:00 scheduler jobs.

use std::{
    fs,
    future::Future,
    io::Write,
    path::{Path, PathBuf},
};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::cognition::ensure_data_authority;

const DUE_MINUTE: u16 = 4 * 60;

pub(super) async fn run_due<F>(
    data_root: &Path,
    id: &'static str,
    day: &str,
    minute: u16,
    now_ms: i64,
    cancellation: &CancellationToken,
    operation: F,
) -> Result<bool, String>
where
    F: Future<Output = Result<(), String>>,
{
    if !matches!(id, "session-sync" | "consolidation-cycle") {
        return Err("unknown_scheduler_job".into());
    }
    if cancellation.is_cancelled() || minute < DUE_MINUTE {
        return Ok(false);
    }
    let root = data_root.to_path_buf();
    let marker = state_path(&root, id);
    let day_to_check = day.to_owned();
    let due = tokio::task::spawn_blocking(move || should_run(&root, &marker, &day_to_check))
        .await
        .map_err(|_| "scheduler_state_worker_failed".to_owned())??;
    if !due {
        return Ok(false);
    }
    if cancellation.is_cancelled() {
        return Ok(false);
    }
    let result = operation.await;
    let mut marker = json!({
        "lastRunDate": day,
        "lastRunAt": iso_at(now_ms),
        "status": if result.is_ok() { "ok" } else { "error" },
    });
    if let Err(message) = &result {
        marker["message"] = json!(message.chars().take(500).collect::<String>());
    }
    let root = data_root.to_path_buf();
    tokio::task::spawn_blocking(move || write_state(&root, id, &marker))
        .await
        .map_err(|_| "scheduler_state_worker_failed".to_owned())??;
    result.map(|()| true)
}

fn state_path(data_root: &Path, id: &str) -> PathBuf {
    data_root.join("state/scheduler").join(format!("{id}.json"))
}

fn should_run(data_root: &Path, path: &Path, day: &str) -> Result<bool, String> {
    ensure_data_authority(data_root, &[path]).map_err(|error| error.code.to_owned())?;
    Ok(fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value["lastRunDate"].as_str().map(str::to_owned))
        .as_deref()
        != Some(day))
}

fn write_state(data_root: &Path, id: &str, state: &Value) -> Result<(), String> {
    let path = state_path(data_root, id);
    let parent = path.parent().ok_or("scheduler_state_path_invalid")?;
    ensure_data_authority(data_root, &[parent, &path]).map_err(|error| error.code.to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".{id}-{}.tmp", uuid::Uuid::new_v4()));
    ensure_data_authority(data_root, &[&path, &temporary])
        .map_err(|error| error.code.to_owned())?;
    let result = (|| {
        let mut bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        ensure_data_authority(data_root, &[&path, &temporary])
            .map_err(|error| error.code.to_owned())?;
        fs::rename(&temporary, &path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
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

    #[tokio::test]
    async fn failure_and_success_both_suppress_same_local_day() {
        let root =
            std::env::temp_dir().join(format!("butler-daily-schedule-{}", uuid::Uuid::new_v4()));
        let cancellation = CancellationToken::new();
        assert!(
            !run_due(
                &root,
                "session-sync",
                "2026-09-23",
                239,
                0,
                &cancellation,
                async { panic!("before due time") }
            )
            .await
            .unwrap()
        );
        assert_eq!(
            run_due(
                &root,
                "session-sync",
                "2026-09-23",
                240,
                0,
                &cancellation,
                async { Err("failed".into()) }
            )
            .await
            .unwrap_err(),
            "failed"
        );
        assert!(
            run_due(
                &root,
                "consolidation-cycle",
                "2026-09-23",
                240,
                0,
                &cancellation,
                async { Ok(()) }
            )
            .await
            .unwrap()
        );
        assert!(
            !run_due(
                &root,
                "session-sync",
                "2026-09-23",
                240,
                0,
                &cancellation,
                async { panic!("same day already attempted") }
            )
            .await
            .unwrap()
        );
        assert!(
            run_due(
                &root,
                "session-sync",
                "2026-09-24",
                240,
                0,
                &cancellation,
                async { Ok(()) }
            )
            .await
            .unwrap()
        );
        assert!(
            !run_due(
                &root,
                "session-sync",
                "2026-09-24",
                240,
                0,
                &cancellation,
                async { panic!("same day already attempted") }
            )
            .await
            .unwrap()
        );
        let closing = CancellationToken::new();
        closing.cancel();
        assert!(
            !run_due(
                &root,
                "consolidation-cycle",
                "2026-09-24",
                240,
                0,
                &closing,
                async { panic!("closed scheduler admitted work") }
            )
            .await
            .unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
