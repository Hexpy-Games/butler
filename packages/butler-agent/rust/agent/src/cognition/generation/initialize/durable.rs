use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
};

use serde_json::Value;

use crate::cognition::{CognitionError, CognitionResult};

pub(in crate::cognition::generation) fn write_json(
    path: &Path,
    value: &Value,
) -> CognitionResult<()> {
    let parent = path.parent().expect("generation path has parent");
    create_dir(parent)?;
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(io_error)?;
        file.write_all(value.to_string().as_bytes())
            .map_err(io_error)?;
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(io_error)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path).map_err(io_error)
    }
}

pub(super) fn io_error(error: std::io::Error) -> CognitionError {
    CognitionError::new("memory_initialization_io_error", error.to_string())
}
