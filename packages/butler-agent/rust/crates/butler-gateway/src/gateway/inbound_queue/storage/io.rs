//! Atomic source-format record writes and bounded record reads.

use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::Path,
};

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
    let temp = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let file = File::create_new(&temp).map_err(io_error)?;
        secure_fs::restrict_open_file(&file).map_err(io_error)?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, record).map_err(|error| {
            InboundQueueError::new(
                InboundQueueCode::InboundQueueEncodeFailed,
                error.to_string(),
            )
            .with_source(error)
        })?;
        writer.write_all(b"\n").map_err(io_error)?;
        writer.flush().map_err(io_error)?;
        fs::rename(&temp, path).map_err(io_error)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
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
