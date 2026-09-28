//! Private append-only compaction evidence and per-session locking.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use super::ContextCompactionSnapshot;
use crate::context::ContextCode;
use crate::context::{ContextError, ContextResult};

pub(super) fn append_snapshot(
    data_root: &Path,
    snapshot: &ContextCompactionSnapshot,
) -> ContextResult<()> {
    let path = compaction_snapshot_path(data_root, &snapshot.session_id);
    let parent = path.parent().ok_or_else(|| {
        ContextError::new(
            ContextCode::ContextCompactionPathInvalid,
            "Snapshot path has no parent",
        )
    })?;
    fs::create_dir_all(parent).map_err(snapshot_io_error)?;
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    butler_platform::secure_fs::owner_only(&mut options);
    let mut file = options.open(path).map_err(snapshot_io_error)?;
    serde_json::to_writer(&mut file, snapshot).map_err(|error| {
        ContextError::new(
            ContextCode::ContextCompactionSnapshotError,
            error.to_string(),
        )
        .with_source(error)
    })?;
    file.write_all(b"\n").map_err(snapshot_io_error)
}

pub fn compaction_snapshot_path(data_root: &Path, session_id: &str) -> PathBuf {
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
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(lock_io_error)?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match tokio::fs::create_dir(&lock_path).await {
                Ok(()) => return Ok(Self { path: lock_path }),
                // Only a held lock is worth waiting for; other failures are final.
                Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => {
                    return Err(lock_io_error(error));
                }
                Err(_) if Instant::now() >= deadline => {
                    return Err(ContextError::new(
                        ContextCode::ContextCompactionLockTimeout,
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
    ContextError::new(
        ContextCode::ContextCompactionSnapshotError,
        error.to_string(),
    )
    .with_source(error)
}

fn lock_io_error(error: std::io::Error) -> ContextError {
    ContextError::new(ContextCode::ContextCompactionLockError, error.to_string()).with_source(error)
}
