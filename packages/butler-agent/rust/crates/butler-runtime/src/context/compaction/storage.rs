//! Private append-only compaction evidence and per-session locking.

use std::{
    fs::OpenOptions,
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
    butler_platform::secure_fs::create_private_dir_all(parent).map_err(snapshot_io_error)?;
    let existed = path.try_exists().map_err(snapshot_io_error)?;
    let mut bytes = serde_json::to_vec(snapshot).map_err(|error| {
        ContextError::new(
            ContextCode::ContextCompactionSnapshotError,
            error.to_string(),
        )
        .with_source(error)
    })?;
    bytes.push(b'\n');
    let mut file = butler_platform::secure_fs::append_private(&path).map_err(snapshot_io_error)?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(snapshot_io_error)?;
    if !existed {
        butler_platform::secure_fs::sync_directory(parent)
            .unwrap_or(Ok(()))
            .map_err(snapshot_io_error)?;
    }
    Ok(())
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

pub(crate) struct CompactionLock {
    _lock: butler_platform::instance::InstanceLock,
}

impl CompactionLock {
    pub(crate) async fn acquire(data_root: &Path, session_id: &str) -> ContextResult<Self> {
        let snapshot = compaction_snapshot_path(data_root, session_id);
        // Keep a stable lock inode. Old crash-left mkdir locks must not block recovery.
        let lock_path = snapshot.with_extension("flock");
        if let Some(parent) = lock_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(lock_io_error)?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let path = lock_path.clone();
            let result = tokio::task::spawn_blocking(move || {
                let mut options = OpenOptions::new();
                options.create(true).read(true).write(true);
                butler_platform::secure_fs::owner_only(&mut options);
                butler_platform::secure_fs::no_follow(&mut options);
                let file = options
                    .open(path)
                    .map_err(butler_platform::instance::LockError::Failed)?;
                butler_platform::instance::InstanceLock::try_exclusive(file)
            })
            .await
            .map_err(|error| lock_io_error(std::io::Error::other(error)))?;
            match result {
                Ok(lock) => return Ok(Self { _lock: lock }),
                Err(butler_platform::instance::LockError::Failed(error)) => {
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
