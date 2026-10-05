use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

// Forced release is terminal for this service process. No later persist may publish.
static DEADLINE_RELEASE: AtomicBool = AtomicBool::new(false);

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
    let temporary = staged_record_path(path, record.pid, &record.nonce);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let _ = secure_fs::owner_only(&mut options);
    let mut file = options.open(&temporary).map_err(|source| {
        crate::host::HostError::new("native_service_instance_state_unavailable").with_source(source)
    })?;
    // Check after creation: a writer that opens after cancellation must still
    // discard its staging file instead of resurrecting the published record.
    if DEADLINE_RELEASE.load(Ordering::Acquire) {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err("native_service_record_released".into());
    }
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
        super::record_fault::hold_write(record);
        super::record_fault::hold_rename();
        // Forced cleanup can fence publication while this staged writer waits.
        // It must release the record lock without renaming or syncing a record
        // that the deadline thread is about to remove.
        if DEADLINE_RELEASE.load(Ordering::Acquire) {
            return Err("native_service_record_released".into());
        }
        super::super::shutdown_trace::measure_sync("instance_file_rename", || {
            secure_fs::rename(&temporary, path)
        })
        .map_err(|source| {
            crate::host::HostError::new("native_service_instance_state_unavailable")
                .with_source(source)
        })?;
        super::super::shutdown_trace::measure_sync("instance_directory_fsync", || {
            secure_fs::sync_directory(parent).unwrap_or(Ok(()))
        })
        .map_err(|source| {
            crate::host::HostError::new("native_service_instance_state_unavailable")
                .with_source(source)
        })
    })();
    super::super::shutdown_trace::measure_sync("instance_staged_file_close", || drop(file));
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    super::super::shutdown_trace::event(if result.is_ok() {
        "instance_write:end"
    } else {
        "instance_write:failed"
    });
    super::record_fault::write_finished();
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
            Err(butler_platform::instance::LockError::Busy) => {
                super::record_fault::lock_wait();
            }
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

fn staged_record_path(path: &Path, pid: u32, nonce: &str) -> PathBuf {
    // Record updates already hold the DATA record lock, so one staging name
    // per owner is enough and lets the deadline cancel even a pending rename.
    path.with_extension(format!("json.{pid}.{nonce}.tmp"))
}

pub(super) fn fence_deadline_writes() {
    DEADLINE_RELEASE.store(true, Ordering::Release);
}

pub(super) fn cancel_staged_write(path: &Path, nonce: &str) -> io::Result<()> {
    let staged = staged_record_path(path, std::process::id(), nonce);
    match fs::remove_file(staged) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    // Removing the rename source precedes removing its destination. Whether
    // the rename won or lost that race, it cannot publish after final removal.
    super::super::shutdown_trace::event("instance_release:staged_write_cancelled");
    super::record_fault::cancel_rename();
    Ok(())
}
