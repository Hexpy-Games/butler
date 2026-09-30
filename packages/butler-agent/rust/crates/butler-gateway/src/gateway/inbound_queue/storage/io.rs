//! Atomic source-format record writes and bounded record reads.

use std::{fs, io::Write, path::Path};

use butler_platform::secure_fs;

use super::super::{InboundQueueError, QueueResult, QueuedInboundEvent};
use crate::gateway::InboundQueueCode;

pub(super) fn read(path: &Path) -> QueueResult<Option<QueuedInboundEvent>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    let Ok(record): Result<QueuedInboundEvent, _> = serde_json::from_slice(&bytes) else {
        return Ok(None);
    };
    if record.version != 1 || record.queue_id.is_empty() {
        return Ok(None);
    }
    Ok(Some(record))
}

pub(super) fn atomic_write(path: &Path, record: &QueuedInboundEvent) -> QueueResult<()> {
    let parent = path.parent().ok_or_else(|| {
        InboundQueueError::new(
            InboundQueueCode::InboundQueuePathInvalid,
            "Invalid queue path",
        )
    })?;
    ensure_dir(parent)?;
    let mut bytes = serde_json::to_vec_pretty(record).map_err(|error| {
        InboundQueueError::new(
            InboundQueueCode::InboundQueueEncodeFailed,
            error.to_string(),
        )
        .with_source(error)
    })?;
    bytes.push(b'\n');
    secure_fs::replace_private(
        path,
        |file| file.write_all(&bytes).map_err(io_error),
        io_error,
    )
}

pub(super) fn file_names(path: &Path) -> QueueResult<Vec<String>> {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_error(error)),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(io_error)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".json") {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

pub(super) fn ensure_dir(path: &Path) -> QueueResult<()> {
    secure_fs::create_private_dir_all(path).map_err(io_error)
}

pub(super) fn io_error(error: std::io::Error) -> InboundQueueError {
    InboundQueueError::new(InboundQueueCode::InboundQueueIoFailed, error.to_string())
        .with_source(error)
}
