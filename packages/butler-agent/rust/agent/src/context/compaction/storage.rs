//! Private append-only compaction evidence and per-session locking.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use super::ContextCompactionSnapshot;
use crate::context::{ContextError, ContextResult};

pub(super) fn append_snapshot(
    data_root: &Path,
    snapshot: &ContextCompactionSnapshot,
) -> ContextResult<()> {
    let path = compaction_snapshot_path(data_root, &snapshot.session_id);
    let parent = path.parent().ok_or_else(|| {
        ContextError::new(
            "context_compaction_path_invalid",
            "Snapshot path has no parent",
        )
    })?;
    fs::create_dir_all(parent).map_err(snapshot_io_error)?;
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(snapshot_io_error)?;
    serde_json::to_writer(&mut file, snapshot).map_err(|error| {
        ContextError::new("context_compaction_snapshot_error", error.to_string())
    })?;
    file.write_all(b"\n").map_err(snapshot_io_error)
}

pub(crate) fn compaction_snapshot_path(data_root: &Path, session_id: &str) -> PathBuf {
    let safe_id = session_id
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-') {
                value
            } else {
                '_'
            }
        })
        .collect::<String>();
    data_root
        .join("context/compactions")
        .join(format!("{safe_id}.jsonl"))
}

pub(super) struct CompactionLock {
    path: PathBuf,
}

impl CompactionLock {
    pub(super) async fn acquire(data_root: &Path, session_id: &str) -> ContextResult<Self> {
        let snapshot = compaction_snapshot_path(data_root, session_id);
        let lock_path = snapshot.with_extension("lock");
        if let Some(parent) = lock_path.parent() {
            fs::create_dir_all(parent).map_err(lock_io_error)?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match fs::create_dir(&lock_path) {
                Ok(()) => return Ok(Self { path: lock_path }),
                Err(_) if Instant::now() >= deadline => {
                    return Err(ContextError::new(
                        "context_compaction_lock_timeout",
                        format!("Context compaction lock timed out for {session_id}"),
                    ));
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
            }
        }
    }
}

impl Drop for CompactionLock {
    fn drop(&mut self) {
        let _ignored_lock_cleanup = fs::remove_dir_all(&self.path);
    }
}

fn snapshot_io_error(error: std::io::Error) -> ContextError {
    ContextError::new("context_compaction_snapshot_error", error.to_string())
}

fn lock_io_error(error: std::io::Error) -> ContextError {
    ContextError::new("context_compaction_lock_error", error.to_string())
}
