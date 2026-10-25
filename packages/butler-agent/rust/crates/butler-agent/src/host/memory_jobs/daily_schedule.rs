//! Durable local-day intents for the two 04:00 scheduler jobs.

use std::{
    fs,
    future::Future,
    io::Write,
    path::{Path, PathBuf},
};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use butler_memory::cognition::ensure_data_authority;

const DUE_MINUTE: u16 = 4 * 60;

pub(in crate::host) async fn run_due<F, Work>(
    data_root: &Path,
    id: &'static str,
    day: &str,
    minute: u16,
    now_ms: i64,
    cancellation: &CancellationToken,
    operation: F,
) -> Result<bool, crate::host::HostError>
where
    F: FnOnce(String, i64) -> Work,
    Work: Future<Output = Result<(), crate::host::HostError>>,
{
    if !matches!(id, "session-sync" | "consolidation-cycle") {
        return Err("unknown_scheduler_job".into());
    }
    if cancellation.is_cancelled() || minute < DUE_MINUTE {
        return Ok(false);
    }
    let root = data_root.to_path_buf();
    let day_to_check = day.to_owned();
    let intent = tokio::task::spawn_blocking(move || prepare_run(&root, id, &day_to_check, now_ms))
        .await
        .map_err(|source| {
            crate::host::HostError::new("scheduler_state_worker_failed").with_source(source)
        })??;
    let Some(mut marker) = intent else {
        return Ok(false);
    };
    if cancellation.is_cancelled() {
        return Ok(false);
    }
    let run_id = marker["runId"]
        .as_str()
        .ok_or("scheduler_intent_invalid")?
        .to_owned();
    let started = marker["scheduledAtMs"]
        .as_i64()
        .ok_or("scheduler_intent_invalid")?;
    let result = operation(run_id, started).await;
    // Shutdown leaves the same intent recoverable. Other outcomes retain
    // the existing once-per-local-day policy, including writer contention.
    if result.is_err() && cancellation.is_cancelled() {
        return result.map(|()| true);
    }
    marker["lastRunDate"] = json!(day);
    marker["status"] = json!(if result.is_ok() { "ok" } else { "error" });
    if let Err(message) = &result {
        marker["message"] = json!(message.message().chars().take(500).collect::<String>());
    }
    let root = data_root.to_path_buf();
    tokio::task::spawn_blocking(move || write_state(&root, id, &marker))
        .await
        .map_err(|source| {
            crate::host::HostError::new("scheduler_state_worker_failed").with_source(source)
        })??;
    result.map(|()| true)
}

fn state_path(data_root: &Path, id: &str) -> PathBuf {
    data_root
        .join(butler_platform::data_paths::SCHEDULER)
        .join(format!("{id}.json"))
}

fn prepare_run(
    data_root: &Path,
    id: &str,
    day: &str,
    now_ms: i64,
) -> Result<Option<Value>, crate::host::HostError> {
    if read_state(data_root, id)?.is_some_and(|state| state["lastRunDate"] == day) {
        return Ok(None);
    }
    let intent_id = format!("{id}.intent");
    if let Some(state) = read_state(data_root, &intent_id)?
        && state["scheduledDate"] == day
    {
        return Ok(Some(state));
    }
    let state = json!({
        "scheduledDate": day,
        "lastRunAt": iso_at(now_ms),
        "scheduledAtMs": now_ms,
        "runId": format!("cr_scheduled_{}", uuid::Uuid::new_v4().simple()),
        "status": "pending",
    });
    // Atomic replacement fsyncs the file before publication. Dispatch starts
    // only after this worker returns, so it can never outrun its durable intent.
    write_state(data_root, &intent_id, &state)?;
    Ok(Some(state))
}

pub(super) fn read_state(
    data_root: &Path,
    id: &str,
) -> Result<Option<Value>, crate::host::HostError> {
    let path = state_path(data_root, id);
    ensure_data_authority(data_root, &[&path]).map_err(|error| error.code().to_owned())?;
    Ok(fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()))
}

pub(super) fn write_state(
    data_root: &Path,
    id: &str,
    state: &Value,
) -> Result<(), crate::host::HostError> {
    let path = state_path(data_root, id);
    let parent = path.parent().ok_or("scheduler_state_path_invalid")?;
    ensure_data_authority(data_root, &[parent, &path]).map_err(|error| error.code().to_owned())?;
    butler_platform::secure_fs::create_private_dir_all(parent)
        .map_err(crate::host::HostError::from_error)?;
    let mut bytes = serde_json::to_vec_pretty(state).map_err(crate::host::HostError::from_error)?;
    bytes.push(b'\n');
    butler_platform::secure_fs::replace_private(
        &path,
        |file| {
            file.write_all(&bytes)
                .map_err(crate::host::HostError::from_error)?;
            ensure_data_authority(data_root, &[&path])
                .map_err(|error| error.code().to_owned().into())
        },
        crate::host::HostError::from_error,
    )
}

pub(super) fn iso_at(now_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now_ms).map_or_else(
        || "1970-01-01T00:00:00.000Z".to_owned(),
        |date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}

#[cfg(test)]
mod tests;
