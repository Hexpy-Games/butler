//! Writing briefing artifacts atomically with private permissions.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::Serialize;

use super::contracts::{BriefingGenerationError, error};
use crate::cognition::BriefingGenerationCode;

pub(super) fn artifact_path(root: &Path, date: &str, project_id: Option<&str>) -> PathBuf {
    let day = root.join("cognition/consolidation/briefings").join(date);
    match project_id {
        None => day.join("general.json"),
        Some(id) => day
            .join("projects")
            .join(format!("{}.json", safe_segment(id))),
    }
}

pub(super) fn write(path: &Path, artifact: &impl Serialize) -> Result<(), BriefingGenerationError> {
    let parent = path.parent().ok_or_else(|| {
        error(
            BriefingGenerationCode::NewChatBriefingWriteFailed,
            "Missing artifact directory",
        )
    })?;
    let mut directory = fs::DirBuilder::new();
    directory.recursive(true);
    butler_platform::secure_fs::owner_only_dirs(&mut directory);
    directory.create(parent).map_err(io_error)?;
    let mut bytes = serde_json::to_vec_pretty(artifact).map_err(io_error)?;
    bytes.push(b'\n');
    butler_platform::secure_fs::replace_private(
        path,
        |file| file.write_all(&bytes).map_err(io_error),
        io_error,
    )
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
    error(
        BriefingGenerationCode::NewChatBriefingWriteFailed,
        failure.to_string(),
    )
}
