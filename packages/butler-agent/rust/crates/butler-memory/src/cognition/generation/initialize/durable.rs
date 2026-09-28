//! Durable, atomic file writes for generation records.

use std::{io::Write, path::Path};

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
    butler_platform::secure_fs::replace_private(
        path,
        |file| {
            file.write_all(text.as_bytes())?;
            file.write_all(b"\n")
        },
        std::convert::identity,
    )
    .map_err(io_error)
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
