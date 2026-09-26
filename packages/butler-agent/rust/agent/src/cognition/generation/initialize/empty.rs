//! The source's fresh-only gate. Existing source-bearing data requires rebuild.

use std::{fs, path::Path};

use rusqlite::{Connection, OpenFlags};

use crate::{
    cognition::{CognitionError, CognitionResult},
    conversation::{ConversationSourceReader, conversation_store_path},
    work_records::WorkRecordReader,
};

pub(super) fn assert_truly_empty(
    data_root: &Path,
    cognition_root: &Path,
    memory_root: &Path,
) -> CognitionResult<()> {
    if memory_root
        .join("active-generation.json")
        .try_exists()
        .map_err(|_| unreadable())?
        || has_entries(&memory_root.join("generations"))?
    {
        return Err(requires_rebuild());
    }
    if conversation_has_sources(&conversation_store_path(data_root))? {
        return Err(requires_rebuild());
    }
    if !WorkRecordReader::new(data_root)
        .task_ids()
        .map_err(|_| unreadable())?
        .is_empty()
        || nonempty_text(&cognition_root.join("feedback/feedback.md"))?
    {
        return Err(requires_rebuild());
    }
    for root in [
        data_root.join("tasks"),
        cognition_root.join("box"),
        memory_root.join("rules"),
    ] {
        if has_source_files(&root)? {
            return Err(requires_rebuild());
        }
    }
    for path in [
        memory_root.join("db/graph.sqlite"),
        memory_root.join("metadata.sqlite"),
    ] {
        if sqlite_has_rows(&path)? {
            return Err(requires_rebuild());
        }
    }
    for path in [memory_root.join("db/butler.lance"), memory_root.join("hot")] {
        if has_entries(&path)? {
            return Err(requires_rebuild());
        }
    }
    Ok(())
}

fn conversation_has_sources(path: &Path) -> CognitionResult<bool> {
    if !path.try_exists().map_err(|_| unreadable())? {
        return Ok(false);
    }
    let reader = ConversationSourceReader::open(path).map_err(|_| unreadable())?;
    let count = reader
        .count_source_bearing_messages()
        .map_err(|_| unreadable())?;
    reader.close().map_err(|_| unreadable())?;
    Ok(count > 0)
}

fn sqlite_has_rows(path: &Path) -> CognitionResult<bool> {
    if !path.try_exists().map_err(|_| unreadable())? {
        return Ok(false);
    }
    let db = open(path)?;
    let mut statement = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .map_err(|_| unreadable())?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| unreadable())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| unreadable())?;
    for name in names {
        if matches!(
            name.as_str(),
            "memory_state" | "schema_migrations" | "migrations"
        ) {
            continue;
        }
        let safe = name.replace('"', "\"\"");
        let count: i64 = db
            .query_row(&format!("SELECT COUNT(*) FROM \"{safe}\""), [], |row| {
                row.get(0)
            })
            .map_err(|_| unreadable())?;
        if count > 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

fn open(path: &Path) -> CognitionResult<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| unreadable())
}

fn nonempty_text(path: &Path) -> CognitionResult<bool> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(!text.trim().is_empty()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(unreadable()),
    }
}

fn has_entries(path: &Path) -> CognitionResult<bool> {
    match fs::read_dir(path) {
        Ok(mut entries) => entries
            .next()
            .transpose()
            .map(|entry| entry.is_some())
            .map_err(|_| unreadable()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(unreadable()),
    }
}

fn has_source_files(path: &Path) -> CognitionResult<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(unreadable()),
    };
    if metadata.is_file() {
        return Ok(metadata.len() > 0);
    }
    if !metadata.is_dir() {
        return Err(unreadable());
    }
    for entry in fs::read_dir(path).map_err(|_| unreadable())? {
        if has_source_files(&entry.map_err(|_| unreadable())?.path())? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn requires_rebuild() -> CognitionError {
    CognitionError::new(
        "memory_initialization_requires_rebuild",
        "memory_initialization_requires_rebuild",
    )
}
fn unreadable() -> CognitionError {
    CognitionError::new(
        "memory_initialization_source_unreadable",
        "memory_initialization_source_unreadable",
    )
}
