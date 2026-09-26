use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde_json::Value;

use super::contracts::{BriefingGenerationError, error};

pub(super) fn artifact_path(root: &Path, date: &str, project_id: Option<&str>) -> PathBuf {
    let day = root.join("cognition/consolidation/briefings").join(date);
    match project_id {
        None => day.join("general.json"),
        Some(id) => day
            .join("projects")
            .join(format!("{}.json", safe_segment(id))),
    }
}

pub(super) fn write(path: &Path, artifact: &Value) -> Result<(), BriefingGenerationError> {
    let parent = path.parent().ok_or_else(|| {
        error(
            "new_chat_briefing_write_failed",
            "Missing artifact directory",
        )
    })?;
    let mut directory = fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(parent).map_err(io_error)?;
    let temporary = path.with_extension(format!("json.tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(io_error)?;
        let mut bytes = serde_json::to_vec_pretty(artifact).map_err(io_error)?;
        bytes.push(b'\n');
        file.write_all(&bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        fs::rename(&temporary, path).map_err(io_error)?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(io_error)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(super) fn safe_segment(value: &str) -> String {
    let mut result = String::new();
    for ch in value.trim().chars() {
        result.push(
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            },
        );
    }
    while result.contains("__") {
        result = result.replace("__", "_");
    }
    if result.is_empty() {
        "project".into()
    } else {
        result
    }
}

fn io_error(failure: impl std::fmt::Display) -> BriefingGenerationError {
    error("new_chat_briefing_write_failed", failure.to_string())
}
