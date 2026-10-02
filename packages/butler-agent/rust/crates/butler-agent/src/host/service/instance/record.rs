use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use butler_platform::instance::InstanceLock;
use butler_platform::secure_fs;

use super::{INSTANCE_SCHEMA, InstanceRecord, open_lock};

pub(super) fn read_record_at(
    path: &Path,
) -> Result<Option<InstanceRecord>, crate::host::HostError> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("native_service_instance_ambiguous: invalid instance record".into());
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("native_service_instance_record_unreadable".into()),
    };
    let record: InstanceRecord = serde_json::from_slice(&bytes).map_err(|source| {
        crate::host::HostError::new("native_service_instance_ambiguous: invalid instance record")
            .with_source(source)
    })?;
    if record.schema != INSTANCE_SCHEMA
        || record.nonce.is_empty()
        || record.pid == 0
        || record.process_start.is_empty()
        || record.executable.is_empty()
    {
        return Err("native_service_instance_ambiguous: incomplete instance record".into());
    }
    Ok(Some(record))
}

pub(super) fn write_record(
    path: &Path,
    record: &InstanceRecord,
) -> Result<(), crate::host::HostError> {
    super::super::shutdown_trace::event("instance_write:begin");
    let parent = path
        .parent()
        .ok_or_else(|| "native_service_instance_record_path_invalid".to_owned())?;
    secure_fs::create_private_dir_all(parent).map_err(|source| {
        crate::host::HostError::new("native_service_instance_state_unavailable").with_source(source)
    })?;
    let temporary = path.with_extension(format!(
        "json.{}.{}.{}.tmp",
        record.pid,
        record.nonce,
        uuid::Uuid::new_v4()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let _ = secure_fs::owner_only(&mut options);
    let mut file = options.open(&temporary).map_err(|source| {
        crate::host::HostError::new("native_service_instance_state_unavailable").with_source(source)
    })?;
    let result = (|| {
        serde_json::to_writer_pretty(&mut file, record).map_err(|source| {
            crate::host::HostError::new("native_service_instance_state_unavailable")
                .with_source(source)
        })?;
        file.write_all(b"\n").map_err(|source| {
            crate::host::HostError::new("native_service_instance_state_unavailable")
                .with_source(source)
        })?;
        super::super::shutdown_trace::measure_sync("instance_file_fsync", || file.sync_all())
            .map_err(|source| {
                crate::host::HostError::new("native_service_instance_state_unavailable")
                    .with_source(source)
            })?;
        hold_shutdown_write(record);
        super::super::shutdown_trace::measure_sync("instance_file_rename", || {
            secure_fs::rename(&temporary, path)
        })
        .map_err(|source| {
            crate::host::HostError::new("native_service_instance_state_unavailable")
                .with_source(source)
        })?;
        secure_fs::sync_directory(parent)
            .unwrap_or(Ok(()))
            .map_err(|source| {
                crate::host::HostError::new("native_service_instance_state_unavailable")
                    .with_source(source)
            })
    })();
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    super::super::shutdown_trace::event(if result.is_ok() {
        "instance_write:end"
    } else {
        "instance_write:failed"
    });
    result
}

/// Waits for the lock that serializes record updates; held while the value
/// lives.
pub(super) fn acquire_record_update_lock(
    path: &Path,
) -> Result<InstanceLock, crate::host::HostError> {
    let file = open_lock(path, true)?;
    InstanceLock::exclusive(file)
        .map_err(|error| format!("native_service_record_lock_failed: {error}"))
        .map_err(crate::host::HostError::from)
}

pub(super) fn record_update_lock_path(data_root: &Path) -> PathBuf {
    data_root.join("state/butler-agent-native-service-record.lock")
}

pub(super) fn instance_record_path(data_root: &Path) -> PathBuf {
    data_root.join("state/butler-agent-native-service.json")
}

/// Stub-only reproduction of a slow fsync while the record lock is held.
fn hold_shutdown_write(record: &InstanceRecord) {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub")
        || record.state != "ready"
        || record.app_enabled
    {
        return;
    }
    let Some(ms) = std::env::var("BUTLER_E2E_RECORD_WRITE_RELEASE_AFTER_STOP_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return;
    };
    let Some(elapsed) = super::super::shutdown_trace::stop_elapsed() else {
        return;
    };
    super::super::shutdown_trace::event("record_write_hold:begin");
    // Align with the grace deadline, even when earlier close work is slow.
    let remaining = std::time::Duration::from_millis(ms).saturating_sub(elapsed);
    std::thread::sleep(remaining);
    super::super::shutdown_trace::event("record_write_hold:end");
}

/// The grace thread must leave room for the controller's eight-second kill.
pub(super) fn acquire_record_update_lock_until(
    path: &Path,
    budget: std::time::Duration,
) -> Result<Option<InstanceLock>, crate::host::HostError> {
    let deadline = std::time::Instant::now() + budget;
    loop {
        let file = open_lock(path, false)?;
        match InstanceLock::try_exclusive(file) {
            Ok(lock) => return Ok(Some(lock)),
            Err(butler_platform::instance::LockError::Busy) => {}
            Err(butler_platform::instance::LockError::Failed(error)) => {
                return Err(format!("native_service_record_lock_failed: {error}").into());
            }
        }
        let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
            return Ok(None);
        };
        std::thread::sleep(remaining.min(std::time::Duration::from_millis(10)));
    }
}
