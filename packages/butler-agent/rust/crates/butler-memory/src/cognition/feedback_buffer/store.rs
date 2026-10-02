//! Memory-owned durable pending receipts. Canonical writes remain lease serialized.
use super::{
    FeedbackEntry,
    operator::{create_private_dir, read_entries, write_entries},
};
use crate::cognition::{CognitionCode, CognitionError, CognitionResult};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

static WORK: std::sync::LazyLock<parking_lot::Mutex<HashSet<PathBuf>>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(HashSet::new()));
pub(super) fn signal(root: &Path) {
    WORK.lock().insert(root.to_owned());
    crate::cognition::signal_memory_work();
}
pub(super) fn take_work(root: &Path) -> bool {
    WORK.lock().remove(root)
}
pub(super) fn failure(source: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryFeedbackBufferWriteFailed,
        "Recent feedback storage failed",
    )
    .with_source(source)
}

pub(super) fn generation(root: &Path) -> CognitionResult<String> {
    match fs::read_to_string(root.join("generation")) {
        Ok(value) => Ok(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("0".into()),
        Err(error) => Err(failure(error)),
    }
}

pub(super) fn replace(path: &Path, text: &str) -> CognitionResult<()> {
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }
    butler_platform::secure_fs::replace_private(
        path,
        |out| out.write_all(text.as_bytes()),
        std::convert::identity,
    )
    .map_err(failure)
}

pub(super) fn pending(root: &Path) -> CognitionResult<Vec<PathBuf>> {
    let directory = match fs::read_dir(root.join("pending")) {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(failure(error)),
    };
    let mut paths = vec![];
    for item in directory {
        let item = item.map_err(failure)?;
        if item.file_type().map_err(failure)?.is_file()
            && item.path().extension().is_some_and(|x| x == "md")
        {
            paths.push(item.path());
        }
    }
    paths.sort();
    Ok(paths)
}

pub(crate) fn snapshot(root: &Path) -> CognitionResult<Vec<FeedbackEntry>> {
    let generation = generation(root)?;
    let mut entries = read_entries(&root.join("feedback.md"))?;
    for entry in &mut entries {
        if entry
            .extra_fields
            .get("reset_generation")
            .map_or(generation != "0", |g| g != &generation)
        {
            entry.status = super::FeedbackStatus::Discarded;
            entry.text.clear();
            entry
                .extra_fields
                .insert("resolution_reason".into(), "owner_reset".into());
        }
    }
    let mut ids = entries
        .iter()
        .map(|e| e.feedback_id.clone())
        .collect::<HashSet<_>>();
    let paths = pending(root)?;
    if !paths.is_empty() {
        signal(root);
    }
    for path in paths {
        for entry in read_entries(&path)? {
            if entry.extra_fields.get("reset_generation") == Some(&generation)
                && ids.insert(entry.feedback_id.clone())
            {
                entries.push(entry);
            }
        }
    }
    Ok(entries)
}

pub(super) fn drain(root: &Path) -> CognitionResult<usize> {
    let paths = pending(root)?;
    if paths.is_empty() {
        return Ok(0);
    }
    let entries = snapshot(root)?;
    write_entries(&root.join("feedback.md"), &entries)?;
    for path in &paths {
        fs::remove_file(path).map_err(failure)?;
    }
    Ok(paths.len())
}
