use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::fs::File;

use crate::cognition::CognitionResult;

use super::{error, index::BoxIndexReport};

pub(super) fn create_private_dir(path: &Path) -> CognitionResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => return Ok(()),
            Ok(_) => return Err(error("memory_box_index_write_failed")),
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error("memory_box_index_write_failed")),
        }
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        match builder.create(path) {
            Ok(()) => Ok(()),
            Err(io_error) if io_error.kind() == std::io::ErrorKind::AlreadyExists => {
                fs::symlink_metadata(path)
                    .ok()
                    .filter(|metadata| metadata.file_type().is_dir())
                    .map(|_| ())
                    .ok_or_else(|| error("memory_box_index_write_failed"))
            }
            Err(_) => Err(error("memory_box_index_write_failed")),
        }
    }
    #[cfg(not(unix))]
    {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
            Ok(_) => Err(error("memory_box_index_write_failed")),
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir_all(path).map_err(|_| error("memory_box_index_write_failed"))
            }
            Err(_) => Err(error("memory_box_index_write_failed")),
        }
    }
}

pub(super) fn create_private_file(path: &Path) -> CognitionResult<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| error("memory_box_index_write_failed"))?;
    Ok(())
}

pub(super) fn write_report(path: &Path, report: &BoxIndexReport) -> CognitionResult<()> {
    let mut bytes =
        serde_json::to_vec_pretty(report).map_err(|_| error("memory_box_report_write_failed"))?;
    bytes.push(b'\n');
    let parent = path.parent().unwrap_or(Path::new("."));
    let temporary = parent.join(format!("index-rebuild-report.tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        create_private_file(&temporary)?;
        let mut file = OpenOptions::new()
            .write(true)
            .open(&temporary)
            .map_err(|_| error("memory_box_report_write_failed"))?;
        file.write_all(&bytes)
            .map_err(|_| error("memory_box_report_write_failed"))?;
        file.sync_all()
            .map_err(|_| error("memory_box_report_write_failed"))?;
        fs::rename(&temporary, path).map_err(|_| error("memory_box_report_write_failed"))?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| error("memory_box_report_write_failed"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub(super) fn now_iso() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    crate::js_date::format_iso_millis(millis).unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into())
}
