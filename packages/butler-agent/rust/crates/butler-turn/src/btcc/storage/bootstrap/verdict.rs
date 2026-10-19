//! Durable scan verdicts, with corruption identity sealed after writer shutdown.
use super::{StorageError, StorageResult, error, io_error};
use crate::btcc::StorageCode;
use std::io::Read;
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

/// Physical legacy verdicts fail closed; legacy logical findings need a recheck.
/// A recorded identity permits recovery only after a proven replacement.
pub(super) fn needs_recheck(path: &Path) -> StorageResult<bool> {
    let file = match std::fs::File::open(sidecar(path, "corrupt")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io_error(error)),
    };
    let mut raw = String::new();
    file.take(4096).read_to_string(&mut raw).map_err(io_error)?;
    let (code, identity) = raw.split_once('\n').unwrap_or((&raw, ""));
    match serde_json::from_str::<DatabaseIdentity>(identity) {
        Ok(recorded) if recorded != DatabaseIdentity::read(path)? => return Ok(true),
        Err(_) if physical_code(code).is_none() => return Ok(true),
        _ => {}
    }
    Err(error(
        physical_code(code).unwrap_or(StorageCode::AgentBtccStorageQuickCheckFailed),
    ))
}

fn physical_code(code: &str) -> Option<StorageCode> {
    [
        StorageCode::AgentBtccStorageQuickCheckFailed,
        StorageCode::AgentBtccStorageForeignKeyCheckFailed,
    ]
    .into_iter()
    .find(|candidate| candidate.as_str() == code)
}

/// Called after the writer and checkpoint worker have attempted to close.
pub(in crate::btcc::storage) fn refresh_after_close(path: &Path) {
    if let Ok(raw) = std::fs::read_to_string(sidecar(path, "corrupt"))
        && let Some(code) = physical_code(raw.lines().next().unwrap_or_default())
    {
        record_corruption(path, &Err(error(code)));
    }
}

#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct DatabaseIdentity {
    size: u64,
    modified: Option<(i64, i64)>,
    file_id: Option<(u64, u64)>,
}

impl DatabaseIdentity {
    fn read(path: &Path) -> StorageResult<Self> {
        let metadata = std::fs::metadata(path).map_err(io_error)?;
        let identity = butler_platform::secure_fs::identity(&metadata);
        Ok(Self {
            size: metadata.len(),
            modified: identity
                .modified
                .map(|time| (time.seconds, time.nanoseconds)),
            file_id: identity.id.map(|id| (id.device, id.inode)),
        })
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
    {
        let write = (|| {
            let raw = match DatabaseIdentity::read(path) {
                Ok(identity) => serde_json::to_string(&identity)
                    .map_err(|error| io_error(std::io::Error::other(error)))?,
                Err(_) => String::new(),
            };
            let code = physical_code(error.code())
                .unwrap_or(StorageCode::AgentBtccStorageQuickCheckFailed);
            atomic_write(
                &sidecar(path, "corrupt"),
                format!("{code}\n{raw}").as_bytes(),
            )
        })();
        if let Err(write) = write {
            butler_core::diagnostic!("[btcc-storage] verdict_persist_failed={write}");
        }
    }
}

/// Current logical findings use a separate sidecar. A successful physical check
/// retires any corruption marker, including legacy reference-only markers.
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
