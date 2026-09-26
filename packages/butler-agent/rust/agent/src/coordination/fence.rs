use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use super::error::{CoordinationError, CoordinationResult, sqlite_error, unavailable};
use super::types::{CognitionCoordinationHost, CognitionProcessStatus, LockInfo};

pub(super) const COORDINATOR_VERSION: i64 = 1;
const FENCE_SCHEMA: &str = "butler.memory-write-fence.v1";
const GATE_TABLE: &str = "memory_write_gate";

#[derive(Debug)]
pub(super) struct CoordinatorMeta {
    pub format_version: i64,
    pub fence_sha256: Option<String>,
    pub last_owner: Option<LockInfo>,
}

#[derive(Serialize)]
struct FenceInfo {
    schema: String,
    format_version: i64,
    fence_id: String,
    created_at: String,
}

pub(super) struct FenceClassification {
    pub available: bool,
    pub reason: Option<&'static str>,
    pub bytes: Option<String>,
    pub legacy: Option<LockInfo>,
}

pub(super) fn coordinator_path(path: &Path) -> PathBuf {
    let mut value: OsString = path.as_os_str().to_owned();
    value.push(".coord.sqlite");
    PathBuf::from(value)
}

pub(super) fn open_readonly(path: &Path) -> CoordinationResult<Connection> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(sqlite_error)?;
    connection
        .busy_timeout(Duration::ZERO)
        .map_err(sqlite_error)?;
    Ok(connection)
}

pub(super) fn open_readwrite(path: &Path) -> CoordinationResult<Connection> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(sqlite_error)?;
    connection
        .busy_timeout(Duration::ZERO)
        .map_err(sqlite_error)?;
    Ok(connection)
}

pub(super) fn read_coordinator_meta(
    connection: &Connection,
) -> CoordinationResult<Option<CoordinatorMeta>> {
    let table = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [GATE_TABLE],
            |_| Ok(()),
        )
        .optional()
        .map_err(sqlite_error)?;
    if table.is_none() {
        return Ok(None);
    }
    let row = connection
        .query_row(
            "SELECT format_version,fence_sha256,last_owner_json \
             FROM memory_write_gate WHERE singleton=1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(sqlite_error)?;
    Ok(row.map(
        |(format_version, fence_sha256, last_owner_json)| CoordinatorMeta {
            format_version,
            fence_sha256,
            last_owner: last_owner_json
                .and_then(|value| serde_json::from_str::<Value>(&value).ok())
                .and_then(|value| parse_legacy(&value)),
        },
    ))
}

pub(super) fn read_known_coordinator(
    lock_path: &Path,
) -> CoordinationResult<Option<CoordinatorMeta>> {
    let path = coordinator_path(lock_path);
    if !path.exists() {
        return Ok(None);
    }
    let connection = open_readonly(&path)?;
    let journal: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(sqlite_error)?;
    if !journal.eq_ignore_ascii_case("delete") {
        return Err(unavailable("unexpected coordinator journal mode"));
    }
    let Some(meta) = read_coordinator_meta(&connection)? else {
        return Err(unavailable("coordinator metadata missing"));
    };
    if meta.format_version != COORDINATOR_VERSION {
        return Err(unavailable("coordinator version mismatch"));
    }
    if let Some(expected) = &meta.fence_sha256 {
        let bytes =
            read_fence_bytes(lock_path)?.ok_or_else(|| unavailable("coordinator fence missing"))?;
        if digest(&bytes) != *expected {
            return Err(unavailable("coordinator fence mismatch"));
        }
    }
    Ok(Some(meta))
}

pub(super) fn classify_unbound_fence(
    path: &Path,
    hostname: &str,
    host: &dyn CognitionCoordinationHost,
) -> CoordinationResult<FenceClassification> {
    let Some(bytes) = read_fence_bytes(path)? else {
        return Ok(FenceClassification {
            available: true,
            reason: None,
            bytes: None,
            legacy: None,
        });
    };
    let value: serde_json::Value = match serde_json::from_str(&bytes) {
        Ok(value) => value,
        Err(_) => return Ok(unavailable_fence(bytes, "invalid_fence", None)),
    };
    if valid_fence(&value) {
        return Ok(FenceClassification {
            available: true,
            reason: None,
            bytes: Some(bytes),
            legacy: None,
        });
    }
    let legacy = parse_legacy(&value);
    let Some(legacy) = legacy else {
        return Ok(unavailable_fence(bytes, "invalid_fence", None));
    };
    let dead = legacy.host == hostname
        && host.process_status(legacy.pid) == CognitionProcessStatus::DefinitelyDead;
    if dead {
        Ok(FenceClassification {
            available: true,
            reason: None,
            bytes: Some(bytes),
            legacy: Some(legacy),
        })
    } else {
        Ok(unavailable_fence(
            bytes,
            "legacy_owner_live_or_uncertain",
            Some(legacy),
        ))
    }
}

pub(super) fn initialize_coordinator(
    lock_path: &Path,
    pid: u32,
    host: &Arc<dyn CognitionCoordinationHost>,
) -> CoordinationResult<bool> {
    let path = coordinator_path(lock_path);
    if path.exists() {
        return Ok(false);
    }
    create_parent(&path)?;
    let mut temp_name = path.as_os_str().to_owned();
    temp_name.push(format!(".init-{pid}-{}", host.new_uuid()));
    let temp = PathBuf::from(temp_name);
    let result = (|| {
        let connection = Connection::open(&temp).map_err(unavailable)?;
        connection
            .busy_timeout(Duration::ZERO)
            .map_err(unavailable)?;
        let journal: String = connection
            .query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))
            .map_err(unavailable)?;
        if !journal.eq_ignore_ascii_case("delete") {
            return Err(unavailable("failed to select DELETE journal mode"));
        }
        connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(unavailable)?;
        let setup = connection.execute_batch(
            "CREATE TABLE memory_write_gate (\
             singleton INTEGER PRIMARY KEY CHECK(singleton=1),\
             format_version INTEGER NOT NULL,\
             fence_sha256 TEXT,\
             last_owner_json TEXT);\
             INSERT INTO memory_write_gate(singleton,format_version,fence_sha256,last_owner_json) \
             VALUES(1,1,NULL,NULL);\
             COMMIT",
        );
        if let Err(error) = setup {
            let _ = connection.execute_batch("ROLLBACK");
            return Err(unavailable(error));
        }
        connection
            .close()
            .map_err(|(_, error)| unavailable(error))?;
        File::open(&temp)
            .and_then(|file| file.sync_all())
            .map_err(unavailable)?;
        match std::fs::hard_link(&temp, &path) {
            Ok(()) => {
                sync_parent(&path)?;
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(unavailable(error)),
        }
    })();
    let _ = std::fs::remove_file(&temp);
    result
}

pub(super) fn bind_coordinator_fence(
    lock_path: &Path,
    hostname: &str,
    host: &Arc<dyn CognitionCoordinationHost>,
) -> CoordinationResult<bool> {
    let connection = open_readwrite(&coordinator_path(lock_path))?;
    if let Err(error) = connection.execute_batch("BEGIN IMMEDIATE") {
        return if is_busy(&error) {
            Ok(false)
        } else {
            Err(unavailable(error))
        };
    }
    let result = (|| {
        let meta = read_coordinator_meta(&connection)?
            .filter(|value| value.format_version == COORDINATOR_VERSION)
            .ok_or_else(|| unavailable("coordinator metadata mismatch"))?;
        if let Some(expected) = meta.fence_sha256 {
            let bytes = read_fence_bytes(lock_path)?
                .ok_or_else(|| unavailable("coordinator fence missing"))?;
            if digest(&bytes) != expected {
                return Err(unavailable("coordinator fence mismatch"));
            }
            connection.execute_batch("ROLLBACK").map_err(unavailable)?;
            return Ok(true);
        }
        let mut fence = classify_unbound_fence(lock_path, hostname, host.as_ref())?;
        if !fence.available {
            return Err(CoordinationError::new(
                if fence.reason == Some("legacy_owner_live_or_uncertain") {
                    "memory_write_legacy_blocked"
                } else {
                    "memory_write_gate_unavailable"
                },
                fence.reason.unwrap_or("invalid_fence"),
            ));
        }
        if fence.bytes.is_none() {
            let _ = install_fence(lock_path, host)?;
            fence = classify_unbound_fence(lock_path, hostname, host.as_ref())?;
        }
        if !fence.available || fence.bytes.is_none() {
            return Err(unavailable("coordinator fence unavailable"));
        }
        File::open(lock_path)
            .and_then(|file| file.sync_all())
            .map_err(unavailable)?;
        sync_parent(lock_path)?;
        sync_parent(&coordinator_path(lock_path))?;
        let durable =
            read_fence_bytes(lock_path)?.ok_or_else(|| unavailable("coordinator fence missing"))?;
        if Some(&durable) != fence.bytes.as_ref() {
            return Err(unavailable("coordinator fence changed"));
        }
        connection
            .execute(
                "UPDATE memory_write_gate SET fence_sha256=?1 \
                 WHERE singleton=1 AND fence_sha256 IS NULL",
                [digest(&durable)],
            )
            .map_err(unavailable)?;
        connection.execute_batch("COMMIT").map_err(unavailable)?;
        Ok(true)
    })();
    if result.is_err() {
        let _ = connection.execute_batch("ROLLBACK");
    }
    result
}

fn install_fence(
    path: &Path,
    host: &Arc<dyn CognitionCoordinationHost>,
) -> CoordinationResult<Option<String>> {
    create_parent(path)?;
    let bytes = serde_json::to_string(&FenceInfo {
        schema: FENCE_SCHEMA.into(),
        format_version: 1,
        fence_id: host.new_uuid(),
        created_at: host.now_iso(),
    })
    .map_err(unavailable)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(bytes.as_bytes()).map_err(unavailable)?;
            file.sync_all().map_err(unavailable)?;
            sync_parent(path)?;
            Ok(Some(bytes))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(None),
        Err(error) => Err(unavailable(error)),
    }
}

fn read_fence_bytes(path: &Path) -> CoordinationResult<Option<String>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(unavailable(error)),
    }
}

fn create_parent(path: &Path) -> CoordinationResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| unavailable("coordinator parent missing"))?;
    std::fs::create_dir_all(parent).map_err(unavailable)
}

fn sync_parent(path: &Path) -> CoordinationResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| unavailable("coordinator parent missing"))?;
    File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(unavailable)
}

fn valid_fence(value: &Value) -> bool {
    let Some(row) = value.as_object() else {
        return false;
    };
    row.get("schema").and_then(Value::as_str) == Some(FENCE_SCHEMA)
        && row.get("format_version").and_then(Value::as_f64) == Some(1.0)
        && row
            .get("fence_id")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
        && row.get("created_at").and_then(Value::as_str).is_some()
}

fn parse_legacy(value: &Value) -> Option<LockInfo> {
    let row = value.as_object()?;
    let pid = row.get("pid")?.as_f64()?;
    if !pid.is_finite() || pid.fract() != 0.0 || pid <= 0.0 || pid > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(LockInfo {
        pid: pid as u64,
        started_at: row.get("startedAt")?.as_str()?.into(),
        host: row.get("host")?.as_str()?.into(),
        owner_nonce: row.get("owner_nonce")?.as_str()?.into(),
        purpose: row.get("purpose")?.as_str()?.into(),
    })
}

fn unavailable_fence(
    bytes: String,
    reason: &'static str,
    legacy: Option<LockInfo>,
) -> FenceClassification {
    FenceClassification {
        available: false,
        reason: Some(reason),
        bytes: Some(bytes),
        legacy,
    }
}

pub(super) fn digest(bytes: &str) -> String {
    format!("{:x}", Sha256::digest(bytes.as_bytes()))
}

pub(super) fn is_busy(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(value, _)
            if value.code == rusqlite::ErrorCode::DatabaseBusy
    )
}

pub(super) fn write_owner(connection: &Connection, info: &LockInfo) -> CoordinationResult<()> {
    let json = serde_json::to_string(info).map_err(unavailable)?;
    connection
        .execute(
            "UPDATE memory_write_gate SET last_owner_json=?1 WHERE singleton=1",
            params![json],
        )
        .map_err(sqlite_error)?;
    Ok(())
}
