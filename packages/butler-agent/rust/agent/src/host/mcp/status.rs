//! One-shot system facts for the retained MCP `butler_status` tool.

use std::{fs, path::Path, time::SystemTime};

use nix::{
    errno::Errno,
    fcntl::{Flock, FlockArg},
};

use crate::{models, operations};

use super::super::service_instance;

pub(super) async fn text(data_root: &Path) -> Result<String, String> {
    let models = models::open_status_models(data_root.to_path_buf()).await?;
    let now_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1_000.0;
    let telemetry = operations::read_prompt_cache_telemetry(data_root, Some(now_ms - 86_400_000.0));
    let control = models.render_text(&telemetry, None);
    let counts = operations::read_mcp_task_counts(data_root);
    let hot_files = std::fs::read_dir(data_root.join("cognition/memory/hot"))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".md"))
        .count();
    Ok(format!(
        "Uptime: {}\n{}\nTasks: {} total ({} running, {} done, {} failed)\nContext: native-local session state\nHot cache: {} files",
        uptime(data_root),
        control,
        counts.total,
        counts.running,
        counts.done,
        counts.failed,
        hot_files,
    ))
}

fn uptime(data_root: &Path) -> String {
    let Ok(Some(record)) = service_instance::read_record(data_root) else {
        return "unknown".into();
    };
    if record.state != "ready"
        || !matches!(instance_lock_is_held(data_root), Ok(true))
        || !matches!(service_instance::process_matches(&record), Ok(true))
    {
        return "unknown".into();
    }
    let Some(ready_at) = record.ready_at else {
        return "unknown".into();
    };
    let Ok(started) = chrono::DateTime::parse_from_rfc3339(&ready_at) else {
        return "unknown".into();
    };
    let seconds = chrono::Utc::now()
        .signed_duration_since(started.with_timezone(&chrono::Utc))
        .num_seconds();
    if seconds < 0 {
        return "unknown".into();
    }
    let seconds = u64::try_from(seconds).unwrap_or_default();
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        let hours = seconds / 3_600;
        let minutes = seconds % 3_600 / 60;
        if hours == 0 {
            format!("{minutes}m")
        } else {
            format!("{hours}h {minutes}m")
        }
    }
}

fn instance_lock_is_held(data_root: &Path) -> Result<bool, String> {
    let path = data_root.join("state/butler-agent-native-service.lock");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("service_lock_unavailable".into()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("service_lock_path_ambiguous".into());
        }
        Ok(_) => {}
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .open(&path)
        .map_err(|_| "service_lock_unavailable".to_owned())?;
    match Flock::lock(file, FlockArg::LockSharedNonblock) {
        Ok(_) => Ok(false),
        Err((_, Errno::EAGAIN)) => Ok(true),
        Err((_, error)) => Err(format!("service_lock_probe_failed: {error}")),
    }
}
