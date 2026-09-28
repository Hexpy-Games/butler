//! Durable, atomic file writes for generation records.

use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
};

use serde::Serialize;

use crate::cognition::CognitionCode;
use crate::cognition::{CognitionError, CognitionResult};

/// Atomically replaces `path` with compact JSON and a trailing newline, then
/// syncs the file and its directory.
pub(in crate::cognition::generation) fn write_json<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
) -> CognitionResult<()> {
    let text = serde_json::to_string(value).map_err(|source| {
        CognitionError::new(
            CognitionCode::MemoryInitializationIoError,
            source.to_string(),
        )
        .with_source(source)
    })?;
    let parent = path.parent().ok_or_else(|| {
        CognitionError::new(
            CognitionCode::MemoryGenerationPathInvalid,
            "path has no parent",
        )
    })?;
    create_dir(parent)?;
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        butler_platform::secure_fs::owner_only(&mut options);
        let mut file = options.open(&temporary).map_err(io_error)?;
        file.write_all(text.as_bytes()).map_err(io_error)?;
        file.write_all(b"\n").map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        fs::rename(&temporary, path).map_err(io_error)?;
        File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(io_error)
    })();
    let _ = fs::remove_file(&temporary);
    result
}

pub(in crate::cognition::generation) fn create_dir(path: &Path) -> CognitionResult<()> {
    butler_platform::secure_fs::create_private_dir_all(path).map_err(io_error)
}

pub(super) fn io_error(error: std::io::Error) -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryInitializationIoError,
        error.to_string(),
    )
    .with_source(error)
}
