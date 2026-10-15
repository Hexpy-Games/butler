//! Small durable sidecars; never updated on cancellation, shutdown or idle polls.
use super::{StorageError, StorageResult, io_error};
use crate::btcc::StorageCode;
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
const VERIFIED_INTERVAL: Duration = Duration::from_hours(24);

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    path.with_extension(format!("sqlite.{suffix}"))
}

pub(super) fn corruption(error: &StorageError) -> bool {
    match error {
        StorageError::Sqlite { source } => matches!(
            source.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
        ),
        StorageError::Detected { code, .. } => matches!(
            code,
            StorageCode::AgentBtccStorageQuickCheckFailed
                | StorageCode::AgentBtccStorageForeignKeyCheckFailed
        ),
        _ => false,
    }
}

pub(super) fn needs_recheck(path: &Path) -> StorageResult<bool> {
    match std::fs::metadata(sidecar(path, "corrupt")) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

pub(super) fn scan_delay(path: &Path) -> Duration {
    let Ok(raw) = std::fs::read_to_string(sidecar(path, "verified")) else {
        return Duration::ZERO;
    };
    // DDL during the per-start migrations can advance schema_version. The due
    // time is based on completed verification, not that changing counter.
    let Some((_schema, stamp)) = raw.trim().split_once(':') else {
        return Duration::ZERO;
    };
    let Some(time) = stamp
        .parse::<u64>()
        .ok()
        .and_then(|seconds| SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(seconds)))
    else {
        return Duration::ZERO;
    };
    let age = SystemTime::now()
        .duration_since(time)
        .unwrap_or(VERIFIED_INTERVAL);
    VERIFIED_INTERVAL.saturating_sub(age)
}

pub(super) fn record_corruption(path: &Path, result: &StorageResult<()>) {
    if let Err(error) = result
        && corruption(error)
        && let Err(write) = atomic_write(&sidecar(path, "corrupt"), error.code().as_bytes())
    {
        butler_core::diagnostic!("[btcc-storage] verdict_persist_failed={write}");
    }
}

/// Logical findings never trigger startup validation. A successful physical
/// check retires any corruption marker, including legacy reference-only markers.
pub(in crate::btcc::storage) fn validated(
    path: &Path,
    failures: &[super::validate::ReferenceFailure],
) -> StorageResult<()> {
    if failures.is_empty() {
        clear_sidecar(path, "findings")?;
    } else {
        let code = StorageCode::AgentBtccMigrationReferenceCheckFailed;
        let mut details = format!("{code}\nchecked_at={}", chrono::Utc::now().to_rfc3339());
        for failure in failures {
            let detail = format!("rule={} orphan_count={}", failure.rule, failure.count);
            butler_core::diagnostic!("[btcc-storage] warning {code} {detail}");
            details.push('\n');
            details.push_str(&detail);
        }
        atomic_write(&sidecar(path, "findings"), details.as_bytes())?;
    }
    // Persist the completed scan before retiring its startup recheck marker.
    stamp(path)?;
    clear_sidecar(path, "corrupt")
}

pub(super) fn stamp(path: &Path) -> StorageResult<()> {
    let db =
        butler_platform::sqlite::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(StorageError::sqlite)?;
    let schema: i64 = db
        .pragma_query_value(None, "schema_version", |row| row.get(0))
        .map_err(StorageError::sqlite)?;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    atomic_write(
        &sidecar(path, "verified"),
        format!("{schema}:{now}").as_bytes(),
    )
}

fn clear_sidecar(path: &Path, suffix: &str) -> StorageResult<()> {
    match std::fs::remove_file(sidecar(path, suffix)) {
        Ok(()) => butler_platform::secure_fs::sync_path(path.parent().unwrap_or(Path::new(".")))
            .map_err(io_error),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> StorageResult<()> {
    use std::io::Write;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    butler_platform::secure_fs::owner_only(&mut options);
    let result = (|| {
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        butler_platform::secure_fs::rename(&temp, path)?;
        butler_platform::secure_fs::sync_path(path.parent().unwrap_or(Path::new(".")))
    })();
    let _ = std::fs::remove_file(temp);
    result.map_err(io_error)
}
