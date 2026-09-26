use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

use serde_json::Value;

use crate::cognition::CognitionResult;

use super::error;

pub(super) const ENTRY_SCHEMA: &str = "butler.cognition.knowhow.v1";

#[derive(Clone, Debug)]
pub(super) struct EntryPath {
    pub path: PathBuf,
    pub updated_at: String,
}

const ENTRY_STATUSES: [&str; 6] = [
    "candidate",
    "active",
    "suppressed",
    "needs_review",
    "disabled",
    "forgotten",
];

pub(super) fn list_paths(root: &Path) -> CognitionResult<Vec<EntryPath>> {
    let Some(directory) = entries_directory(root, false)? else {
        return Ok(Vec::new());
    };
    let rows = fs::read_dir(&directory).map_err(|_| error("memory_knowhow_entries_read_failed"))?;
    let mut entries = Vec::new();
    for row in rows {
        let row = row.map_err(|_| error("memory_knowhow_entries_read_failed"))?;
        let path = row.path();
        if !row.file_name().to_string_lossy().ends_with(".json") {
            continue;
        }
        let value = read_path(&directory, &path)?;
        let updated_at = value
            .get("updated_at")
            .and_then(Value::as_str)
            .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
        entries.push(EntryPath {
            path,
            updated_at: updated_at.to_owned(),
        });
    }
    entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(entries)
}

pub(super) fn read_one(root: &Path, entry: &EntryPath) -> CognitionResult<Value> {
    let directory =
        entries_directory(root, false)?.ok_or_else(|| error("memory_knowhow_entry_not_found"))?;
    if entry.path.parent() != Some(directory.as_path()) {
        return Err(error("memory_knowhow_entry_path_unsafe"));
    }
    read_path(&directory, &entry.path)
}

pub(super) fn read_id(root: &Path, id: &str) -> CognitionResult<Option<Value>> {
    if !safe_id(id) {
        return Err(error("memory_knowhow_entry_id_invalid"));
    }
    let Some(directory) = entries_directory(root, false)? else {
        return Ok(None);
    };
    let path = directory.join(format!("{id}.json"));
    match fs::symlink_metadata(&path) {
        Ok(_) => read_path(&directory, &path).map(Some),
        Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error("memory_knowhow_entry_read_failed")),
    }
}

pub(super) fn count_files(root: &Path) -> CognitionResult<usize> {
    let Some(directory) = entries_directory(root, false)? else {
        return Ok(0);
    };
    let rows = fs::read_dir(directory).map_err(|_| error("memory_knowhow_entries_read_failed"))?;
    let mut count = 0;
    for row in rows {
        let row = row.map_err(|_| error("memory_knowhow_entries_read_failed"))?;
        if !row.file_name().to_string_lossy().ends_with(".json") {
            continue;
        }
        if !row
            .file_type()
            .map_err(|_| error("memory_knowhow_entries_read_failed"))?
            .is_file()
        {
            return Err(error("memory_knowhow_entry_path_unsafe"));
        }
        count += 1;
    }
    Ok(count)
}

fn read_path(directory: &Path, path: &Path) -> CognitionResult<Value> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| error("memory_knowhow_entry_read_failed"))?;
    if !metadata.file_type().is_file() {
        return Err(error("memory_knowhow_entry_path_unsafe"));
    }
    let canonical =
        fs::canonicalize(path).map_err(|_| error("memory_knowhow_entry_read_failed"))?;
    if !canonical.starts_with(directory) {
        return Err(error("memory_knowhow_entry_path_unsafe"));
    }
    let file = File::open(canonical).map_err(|_| error("memory_knowhow_entry_read_failed"))?;
    serde_json::from_reader(file).map_err(|_| error("memory_knowhow_entry_invalid"))
}

pub(super) fn write(root: &Path, entry: &Value) -> CognitionResult<()> {
    let issues = validate(entry);
    if !issues.is_empty() {
        return Err(error("memory_knowhow_entry_invalid"));
    }
    let id = entry
        .get("knowhow_id")
        .and_then(Value::as_str)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    let directory = entries_directory(root, true)?
        .ok_or_else(|| error("memory_knowhow_entries_write_failed"))?;
    let path = directory.join(format!("{id}.json"));
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            let canonical =
                fs::canonicalize(&path).map_err(|_| error("memory_knowhow_entry_path_unsafe"))?;
            if !canonical.starts_with(&directory) {
                return Err(error("memory_knowhow_entry_path_unsafe"));
            }
        }
        Ok(_) => return Err(error("memory_knowhow_entry_path_unsafe")),
        Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(error("memory_knowhow_entry_write_failed")),
    }

    let mut bytes =
        serde_json::to_vec_pretty(entry).map_err(|_| error("memory_knowhow_entry_write_failed"))?;
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
        let mut file = options
            .open(&temporary)
            .map_err(|_| error("memory_knowhow_entry_write_failed"))?;
        file.write_all(&bytes)
            .map_err(|_| error("memory_knowhow_entry_write_failed"))?;
        file.sync_all()
            .map_err(|_| error("memory_knowhow_entry_write_failed"))?;
        fs::rename(&temporary, &path).map_err(|_| error("memory_knowhow_entry_write_failed"))?;
        #[cfg(unix)]
        File::open(&directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| error("memory_knowhow_entry_write_failed"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub(super) fn validate(entry: &Value) -> Vec<&'static str> {
    let mut issues = Vec::new();
    if entry.get("schema").and_then(Value::as_str) != Some(ENTRY_SCHEMA) {
        issues.push("schema");
    }
    let id = entry.get("knowhow_id").and_then(Value::as_str);
    if !id.is_some_and(safe_id) {
        issues.push("knowhow_id");
    }
    if entry
        .get("name")
        .and_then(Value::as_str)
        .is_none_or(|name| crate::public_text::trim_js_whitespace(name).is_empty())
    {
        issues.push("name");
    }
    if !entry
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| ENTRY_STATUSES.contains(&status))
    {
        issues.push("status");
    }
    if !entry
        .get("strategy")
        .and_then(Value::as_object)
        .and_then(|strategy| strategy.get("preferred_sources"))
        .is_some_and(Value::is_array)
    {
        issues.push("strategy.preferred_sources");
    }
    issues
}

fn entries_directory(root: &Path, create: bool) -> CognitionResult<Option<PathBuf>> {
    if create {
        ensure_private_dir(root)?;
    } else {
        match fs::symlink_metadata(root) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Err(error("memory_knowhow_root_path_unsafe")),
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(error("memory_knowhow_root_read_failed")),
        }
    }
    let canonical_root =
        fs::canonicalize(root).map_err(|_| error("memory_knowhow_root_read_failed"))?;
    let path = root.join("entries");
    if create {
        ensure_private_dir(&path)?;
    } else {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Err(error("memory_knowhow_entries_path_unsafe")),
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(error("memory_knowhow_entries_read_failed")),
        }
    }
    let canonical =
        fs::canonicalize(&path).map_err(|_| error("memory_knowhow_entries_read_failed"))?;
    if !canonical.starts_with(&canonical_root) || canonical == canonical_root {
        return Err(error("memory_knowhow_entries_path_unsafe"));
    }
    Ok(Some(canonical))
}

fn ensure_private_dir(path: &Path) -> CognitionResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => return Ok(()),
            Ok(_) => return Err(error("memory_knowhow_root_path_unsafe")),
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error("memory_knowhow_root_write_failed")),
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
                    .ok_or_else(|| error("memory_knowhow_root_path_unsafe"))
            }
            Err(_) => Err(error("memory_knowhow_root_write_failed")),
        }
    }
    #[cfg(not(unix))]
    {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
            Ok(_) => Err(error("memory_knowhow_root_path_unsafe")),
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir_all(path).map_err(|_| error("memory_knowhow_root_write_failed"))
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
