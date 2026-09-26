use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

pub(super) fn prune(
    butler_data: &Path,
    identity: &dyn ToolOutputIdentity,
    metrics: &dyn PruneMetricObserver,
    input: PruneToolOutputInput,
) -> ContextResult<PruneToolOutputResult> {
    let now = identity.now();
    let now_ms = epoch_millis(now).trunc();
    let max_age_ms = source_nonnegative(input.max_age_ms, 30.0 * 24.0 * 60.0 * 60.0 * 1_000.0);
    let max_bytes = source_nonnegative(input.max_bytes, 512.0 * 1024.0 * 1024.0);
    let protected = input
        .protected_paths
        .iter()
        .map(|path| lexical_absolute(path))
        .collect::<ContextResult<HashSet<_>>>()?;
    let root = butler_data.join("artifacts/tool-output");
    let mut paths = Vec::new();
    super::reader::walk_files(&root, usize::MAX, &mut paths)?;
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        let metadata = fs::metadata(&path).map_err(io_error)?;
        files.push(FileInfo {
            path,
            size: metadata.len(),
            modified_ms: epoch_millis(metadata.modified().map_err(io_error)?),
        });
    }
    files.sort_by(|a, b| a.modified_ms.total_cmp(&b.modified_ms));
    let mut total = files.iter().map(|file| file.size).sum::<u64>();
    let mut deleted = 0;
    let mut bytes_deleted = 0;
    for file in &files {
        if protected.contains(&lexical_absolute(&file.path)?) {
            continue;
        }
        let too_old = now_ms - file.modified_ms > max_age_ms;
        let over_budget = total as f64 > max_bytes;
        if !too_old && !over_budget {
            continue;
        }
        fs::remove_file(&file.path).map_err(io_error)?;
        deleted += 1;
        bytes_deleted += file.size;
        total -= file.size;
        if let Some(parent) = file.path.parent()
            && fs::read_dir(parent).is_ok_and(|mut entries| entries.next().is_none())
        {
            let _ = fs::remove_dir_all(parent);
        }
    }
    let result = PruneToolOutputResult {
        scanned: files.len(),
        deleted,
        bytes_deleted,
        remaining_bytes: total,
        max_age_ms,
        max_bytes,
        #[cfg(test)]
        raw_text_stored: false,
    };
    if input.record_telemetry {
        metrics.observe_prune(now_ms, &result, protected.len())?;
    }
    Ok(result)
}

struct FileInfo {
    path: std::path::PathBuf,
    size: u64,
    modified_ms: f64,
}

fn epoch_millis(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1_000.0,
        Err(error) => -(error.duration().as_secs_f64() * 1_000.0),
    }
}

fn source_nonnegative(value: Option<f64>, default: f64) -> f64 {
    let value = value.unwrap_or(default);
    if value.is_nan() {
        value
    } else {
        value.max(0.0)
    }
}

fn lexical_absolute(path: &Path) -> ContextResult<std::path::PathBuf> {
    let base = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map_err(io_error)?.join(path)
    };
    let mut clean = std::path::PathBuf::new();
    for part in base.components() {
        match part {
            std::path::Component::ParentDir => {
                clean.pop();
            }
            std::path::Component::CurDir => {}
            part => clean.push(part.as_os_str()),
        }
    }
    Ok(clean)
}

fn io_error(error: std::io::Error) -> ContextError {
    ContextError::new("tool_output_io_error", error.to_string())
}
