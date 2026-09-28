//! Entry files under `know-how/entries/`: listing, reading, validation and
//! atomic private writes.

use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

use crate::cognition::CognitionResult;

use super::document::{KnowHowDocument, KnowHowStatus};
use super::error;
use crate::cognition::CognitionCode;

pub(super) const ENTRY_SCHEMA: &str = "butler.cognition.knowhow.v1";

#[derive(Clone, Debug)]
pub(super) struct EntryPath {
    pub path: PathBuf,
    pub updated_at: String,
}

pub(super) fn list_paths(root: &Path) -> CognitionResult<Vec<EntryPath>> {
    let Some(directory) = entries_directory(root, Presence::Existing)? else {
        return Ok(Vec::new());
    };
    let rows = fs::read_dir(&directory).map_err(|source| {
        error(CognitionCode::MemoryKnowhowEntriesReadFailed).with_source(source)
    })?;
    let mut entries = Vec::new();
    for row in rows {
        let row = row.map_err(|source| {
            error(CognitionCode::MemoryKnowhowEntriesReadFailed).with_source(source)
        })?;
        let path = row.path();
        if !row.file_name().to_string_lossy().ends_with(".json") {
            continue;
        }
        let entry = read_path(&directory, &path)?;
        let updated_at = KnowHowDocument::required(&entry.updated_at)?.to_owned();
        entries.push(EntryPath { path, updated_at });
    }
    entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(entries)
}

pub(super) fn read_one(root: &Path, entry: &EntryPath) -> CognitionResult<KnowHowDocument> {
    let directory = entries_directory(root, Presence::Existing)?
        .ok_or_else(|| error(CognitionCode::MemoryKnowhowEntryNotFound))?;
    if entry.path.parent() != Some(directory.as_path()) {
        return Err(error(CognitionCode::MemoryKnowhowEntryPathUnsafe));
    }
    read_path(&directory, &entry.path)
}

pub(super) fn read_id(root: &Path, id: &str) -> CognitionResult<Option<KnowHowDocument>> {
    if !safe_id(id) {
        return Err(error(CognitionCode::MemoryKnowhowEntryIdInvalid));
    }
    let Some(directory) = entries_directory(root, Presence::Existing)? else {
        return Ok(None);
    };
    let path = directory.join(format!("{id}.json"));
    match fs::symlink_metadata(&path) {
        Ok(_) => read_path(&directory, &path).map(Some),
        Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error(CognitionCode::MemoryKnowhowEntryReadFailed)),
    }
}

pub(super) fn count_files(root: &Path) -> CognitionResult<usize> {
    let Some(directory) = entries_directory(root, Presence::Existing)? else {
        return Ok(0);
    };
    let rows = fs::read_dir(directory).map_err(|source| {
        error(CognitionCode::MemoryKnowhowEntriesReadFailed).with_source(source)
    })?;
    let mut count = 0;
    for row in rows {
        let row = row.map_err(|source| {
            error(CognitionCode::MemoryKnowhowEntriesReadFailed).with_source(source)
        })?;
        if !row.file_name().to_string_lossy().ends_with(".json") {
            continue;
        }
        if !row
            .file_type()
            .map_err(|source| {
                error(CognitionCode::MemoryKnowhowEntriesReadFailed).with_source(source)
            })?
            .is_file()
        {
            return Err(error(CognitionCode::MemoryKnowhowEntryPathUnsafe));
        }
        count += 1;
    }
    Ok(count)
}

fn read_path(directory: &Path, path: &Path) -> CognitionResult<KnowHowDocument> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| error(CognitionCode::MemoryKnowhowEntryReadFailed).with_source(source))?;
    if !metadata.file_type().is_file() {
        return Err(error(CognitionCode::MemoryKnowhowEntryPathUnsafe));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|source| error(CognitionCode::MemoryKnowhowEntryReadFailed).with_source(source))?;
    if !canonical.starts_with(directory) {
        return Err(error(CognitionCode::MemoryKnowhowEntryPathUnsafe));
    }
    let file = File::open(canonical)
        .map_err(|source| error(CognitionCode::MemoryKnowhowEntryReadFailed).with_source(source))?;
    serde_json::from_reader(file)
        .map_err(|source| error(CognitionCode::MemoryKnowhowEntryInvalid).with_source(source))
}

/// Atomically replaces the entry's file (pretty JSON, mode 0600) after
/// validating it.
pub(super) fn write(root: &Path, document: &KnowHowDocument) -> CognitionResult<()> {
    if !validate(document).is_empty() {
        return Err(error(CognitionCode::MemoryKnowhowEntryInvalid));
    }
    let id = KnowHowDocument::required(&document.knowhow_id)?;
    let directory = entries_directory(root, Presence::Created)?
        .ok_or_else(|| error(CognitionCode::MemoryKnowhowEntriesWriteFailed))?;
    let path = directory.join(format!("{id}.json"));
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            let canonical = fs::canonicalize(&path).map_err(|source| {
                error(CognitionCode::MemoryKnowhowEntryPathUnsafe).with_source(source)
            })?;
            if !canonical.starts_with(&directory) {
                return Err(error(CognitionCode::MemoryKnowhowEntryPathUnsafe));
            }
        }
        Ok(_) => return Err(error(CognitionCode::MemoryKnowhowEntryPathUnsafe)),
        Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(error(CognitionCode::MemoryKnowhowEntryWriteFailed)),
    }

    let mut bytes = serde_json::to_vec_pretty(document).map_err(|source| {
        error(CognitionCode::MemoryKnowhowEntryWriteFailed).with_source(source)
    })?;
    bytes.push(b'\n');
    let temporary = directory.join(format!("{id}.json.tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|source| {
            error(CognitionCode::MemoryKnowhowEntryWriteFailed).with_source(source)
        })?;
        file.write_all(&bytes).map_err(|source| {
            error(CognitionCode::MemoryKnowhowEntryWriteFailed).with_source(source)
        })?;
        file.sync_all().map_err(|source| {
            error(CognitionCode::MemoryKnowhowEntryWriteFailed).with_source(source)
        })?;
        fs::rename(&temporary, &path).map_err(|source| {
            error(CognitionCode::MemoryKnowhowEntryWriteFailed).with_source(source)
        })?;
        #[cfg(unix)]
        File::open(&directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|source| {
                error(CognitionCode::MemoryKnowhowEntryWriteFailed).with_source(source)
            })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

/// The fields that make an entry unusable: schema, a safe `kh_` id, a
/// non-blank name, a known status, and a preferred-sources array.
pub(super) fn validate(entry: &KnowHowDocument) -> Vec<&'static str> {
    let mut issues = Vec::new();
    if entry.schema.valid().map(String::as_str) != Some(ENTRY_SCHEMA) {
        issues.push("schema");
    }
    if !entry.knowhow_id.valid().is_some_and(|id| safe_id(id)) {
        issues.push("knowhow_id");
    }
    if entry
        .name
        .valid()
        .is_none_or(|name| butler_core::public_text::trim_js_whitespace(name).is_empty())
    {
        issues.push("name");
    }
    if !entry.status.valid().is_some_and(KnowHowStatus::is_known) {
        issues.push("status");
    }
    let preferred_sources = match &entry.strategy {
        crate::lenient::Arg::Valid(crate::lenient::Obj(strategy)) => {
            strategy.preferred_sources.valid().is_some()
        }
        _ => false,
    };
    if !preferred_sources {
        issues.push("strategy.preferred_sources");
    }
    issues
}

/// Whether the entries directory is created when missing.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Presence {
    /// Create it (and the know-how root) when missing.
    Created,
    /// Only use it when it already exists.
    Existing,
}

/// The entries directory, checked to stay inside the know-how root; `None`
/// when it does not exist and may not be created.
fn entries_directory(root: &Path, presence: Presence) -> CognitionResult<Option<PathBuf>> {
    let create = presence == Presence::Created;
    if create {
        ensure_private_dir(root)?;
    } else {
        match fs::symlink_metadata(root) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Err(error(CognitionCode::MemoryKnowhowRootPathUnsafe)),
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(error(CognitionCode::MemoryKnowhowRootReadFailed)),
        }
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|source| error(CognitionCode::MemoryKnowhowRootReadFailed).with_source(source))?;
    let path = root.join("entries");
    if create {
        ensure_private_dir(&path)?;
    } else {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Err(error(CognitionCode::MemoryKnowhowEntriesPathUnsafe)),
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(error(CognitionCode::MemoryKnowhowEntriesReadFailed)),
        }
    }
    let canonical = fs::canonicalize(&path).map_err(|source| {
        error(CognitionCode::MemoryKnowhowEntriesReadFailed).with_source(source)
    })?;
    if !canonical.starts_with(&canonical_root) || canonical == canonical_root {
        return Err(error(CognitionCode::MemoryKnowhowEntriesPathUnsafe));
    }
    Ok(Some(canonical))
}

fn ensure_private_dir(path: &Path) -> CognitionResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => return Ok(()),
            Ok(_) => return Err(error(CognitionCode::MemoryKnowhowRootPathUnsafe)),
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error(CognitionCode::MemoryKnowhowRootWriteFailed)),
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
                    .ok_or_else(|| error(CognitionCode::MemoryKnowhowRootPathUnsafe))
            }
            Err(_) => Err(error(CognitionCode::MemoryKnowhowRootWriteFailed)),
        }
    }
    #[cfg(not(unix))]
    {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
            Ok(_) => Err(error("memory_knowhow_root_path_unsafe")),
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir_all(path)
                    .map_err(|source| error("memory_knowhow_root_write_failed").with_source(source))
            }
            Err(_) => Err(error("memory_knowhow_root_write_failed")),
        }
    }
}

fn safe_id(id: &str) -> bool {
    id.starts_with("kh_")
        && !id
            .chars()
            .any(|character| matches!(character, '/' | '\\' | ':' | '\0'))
        && Path::new(id)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}
