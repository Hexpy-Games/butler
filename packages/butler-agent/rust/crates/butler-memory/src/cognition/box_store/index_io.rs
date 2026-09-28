//! Private files and directories of the box index, and its rebuild report.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::cognition::CognitionResult;

use super::{error, index::BoxIndexReport};
use crate::cognition::CognitionCode;

pub(super) fn create_private_dir(path: &Path) -> CognitionResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => return Ok(()),
        Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(error(CognitionCode::MemoryBoxIndexWriteFailed)),
    }
    let mut builder = fs::DirBuilder::new();
    butler_platform::secure_fs::owner_only_dirs(builder.recursive(true));
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(io_error) if io_error.kind() == std::io::ErrorKind::AlreadyExists => {
            fs::symlink_metadata(path)
                .ok()
                .filter(|metadata| metadata.file_type().is_dir())
                .map(|_| ())
                .ok_or_else(|| error(CognitionCode::MemoryBoxIndexWriteFailed))
        }
        Err(_) => Err(error(CognitionCode::MemoryBoxIndexWriteFailed)),
    }
}

pub(super) fn create_private_file(path: &Path) -> CognitionResult<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    butler_platform::secure_fs::owner_only(&mut options);
    options
        .open(path)
        .map_err(|source| error(CognitionCode::MemoryBoxIndexWriteFailed).with_source(source))?;
    Ok(())
}

pub(super) fn write_report(path: &Path, report: &BoxIndexReport) -> CognitionResult<()> {
    let mut bytes = serde_json::to_vec_pretty(report)
        .map_err(|source| error(CognitionCode::MemoryBoxReportWriteFailed).with_source(source))?;
    bytes.push(b'\n');
    let parent = path.parent().unwrap_or(Path::new("."));
    let temporary = parent.join(format!("index-rebuild-report.tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        create_private_file(&temporary)?;
        let mut file = OpenOptions::new()
            .write(true)
            .open(&temporary)
            .map_err(|source| {
                error(CognitionCode::MemoryBoxReportWriteFailed).with_source(source)
            })?;
        file.write_all(&bytes).map_err(|source| {
            error(CognitionCode::MemoryBoxReportWriteFailed).with_source(source)
        })?;
        file.sync_all().map_err(|source| {
            error(CognitionCode::MemoryBoxReportWriteFailed).with_source(source)
        })?;
        fs::rename(&temporary, path).map_err(|source| {
            error(CognitionCode::MemoryBoxReportWriteFailed).with_source(source)
        })?;
        butler_platform::secure_fs::sync_directory(parent).map_err(|source| {
            error(CognitionCode::MemoryBoxReportWriteFailed).with_source(source)
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub(super) fn now_iso() -> String {
    let millis = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(i64::MAX);
    butler_core::js_date::format_iso_millis(millis)
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into())
}
