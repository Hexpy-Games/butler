use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use nix::fcntl::{Flock, FlockArg};

use super::{INSTANCE_SCHEMA, InstanceRecord, open_lock};

pub(super) fn read_record_at(path: &Path) -> Result<Option<InstanceRecord>, String> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("native_service_instance_ambiguous: invalid instance record".into());
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("native_service_instance_record_unreadable".into()),
    };
    let record: InstanceRecord = serde_json::from_slice(&bytes)
        .map_err(|_| "native_service_instance_ambiguous: invalid instance record".to_owned())?;
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

pub(super) fn write_record(path: &Path, record: &InstanceRecord) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "native_service_instance_record_path_invalid".to_owned())?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)
        .map_err(|_| "native_service_instance_state_unavailable".to_owned())?;
    let temporary = path.with_extension(format!(
        "json.{}.{}.{}.tmp",
        record.pid,
        record.nonce,
        uuid::Uuid::new_v4()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| "native_service_instance_state_unavailable".to_owned())?;
    let result = (|| {
        serde_json::to_writer_pretty(&mut file, record)
            .map_err(|_| "native_service_instance_state_unavailable".to_owned())?;
        file.write_all(b"\n")
            .map_err(|_| "native_service_instance_state_unavailable".to_owned())?;
        file.sync_all()
            .map_err(|_| "native_service_instance_state_unavailable".to_owned())?;
        fs::rename(&temporary, path)
            .map_err(|_| "native_service_instance_state_unavailable".to_owned())
    })();
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub(super) fn acquire_record_update_lock(path: &Path) -> Result<Flock<File>, String> {
    let file = open_lock(path, true)?;
    Flock::lock(file, FlockArg::LockExclusive)
        .map_err(|(_, error)| format!("native_service_record_lock_failed: {error}"))
}

pub(super) fn record_update_lock_path(data_root: &Path) -> PathBuf {
    data_root.join("state/butler-agent-native-service-record.lock")
}

pub(super) fn instance_record_path(data_root: &Path) -> PathBuf {
    data_root.join("state/butler-agent-native-service.json")
}
