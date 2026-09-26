use std::{
    fs::{self, OpenOptions},
    path::Path,
};

#[cfg(unix)]
use std::fs::File;

use rusqlite::{Connection, Transaction, params};
use serde_json::Value;

use crate::cognition::CognitionResult;

use super::{entries, error, quality::SourceQualitySummary};

pub(super) fn rebuild(root: &Path, quality: &[SourceQualitySummary]) -> CognitionResult<usize> {
    ensure_private_dir(root)?;
    let entry_paths = entries::list_paths(root)?;
    let path = root.join("index.sqlite");
    let temporary = root.join(format!("index.sqlite.tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        create_private_file(&temporary)?;
        let mut database =
            Connection::open(&temporary).map_err(|_| error("memory_knowhow_index_write_failed"))?;
        create_schema(&database)?;
        let mut indexed = 0;
        for entry_path in &entry_paths {
            let entry = entries::read_one(root, entry_path)?;
            if !entries::validate(&entry).is_empty() {
                continue;
            }
            let transaction = database
                .transaction()
                .map_err(|_| error("memory_knowhow_index_write_failed"))?;
            insert_entry(&transaction, &entry)?;
            transaction
                .commit()
                .map_err(|_| error("memory_knowhow_index_write_failed"))?;
            indexed += 1;
        }
        for summary in quality {
            database
                .execute(
                    "INSERT INTO source_quality_scores VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        summary.source_id,
                        summary.tool_name,
                        summary.score,
                        summary.event_count,
                        summary.negative_feedback_count,
                        summary.last_observed_at,
                    ],
                )
                .map_err(|_| error("memory_knowhow_index_write_failed"))?;
        }
        database
            .close()
            .map_err(|_| error("memory_knowhow_index_write_failed"))?;
        fs::rename(&temporary, &path).map_err(|_| error("memory_knowhow_index_write_failed"))?;
        sync_directory(root)?;
        Ok(indexed)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        if let Some(name) = temporary.file_name().and_then(|name| name.to_str()) {
            let _ = fs::remove_file(root.join(format!("{name}-journal")));
        }
    }
    result
}

fn create_schema(database: &Connection) -> CognitionResult<()> {
    database
        .execute_batch(
            "CREATE TABLE knowhow_entries (
               knowhow_id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
               scope TEXT NOT NULL, summary TEXT, score REAL NOT NULL, confidence REAL NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE knowhow_terms (
               knowhow_id TEXT NOT NULL, term TEXT NOT NULL, kind TEXT NOT NULL,
               PRIMARY KEY (knowhow_id, term, kind)
             );
             CREATE TABLE source_quality_scores (
               source_id TEXT NOT NULL, tool_name TEXT NOT NULL, score REAL NOT NULL,
               event_count INTEGER NOT NULL, negative_feedback_count INTEGER NOT NULL,
               last_observed_at TEXT, PRIMARY KEY (source_id, tool_name)
             );
             CREATE INDEX idx_knowhow_entries_status ON knowhow_entries(status);
             CREATE INDEX idx_knowhow_terms_term ON knowhow_terms(term);",
        )
        .map_err(|_| error("memory_knowhow_index_write_failed"))
}

fn insert_entry(database: &Transaction<'_>, entry: &Value) -> CognitionResult<()> {
    let id = string(entry, "knowhow_id")?;
    let name = string(entry, "name")?;
    let status = string(entry, "status")?;
    let scope = string(entry, "scope")?;
    let summary = entry.get("summary").and_then(Value::as_str);
    let updated_at = string(entry, "updated_at")?;
    let quality = entry
        .get("quality")
        .and_then(Value::as_object)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    let score = quality
        .get("score")
        .and_then(Value::as_f64)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    let confidence = quality
        .get("confidence")
        .and_then(Value::as_f64)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    database
        .execute(
            "INSERT INTO knowhow_entries VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id, name, status, scope, summary, score, confidence, updated_at
            ],
        )
        .map_err(|_| error("memory_knowhow_index_write_failed"))?;

    insert_term(database, id, "name", name)?;
    let aliases = string_array(entry, "aliases")?;
    insert_terms(database, id, "alias", &aliases)?;
    let intent = entry
        .get("intent_match")
        .and_then(Value::as_object)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    let topics = object_string_array(intent, "topics")?;
    insert_terms(database, id, "topic", &topics)?;
    let examples = object_string_array(intent, "examples")?;
    insert_terms(database, id, "example", &examples)?;
    let strategy = entry
        .get("strategy")
        .and_then(Value::as_object)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    let sources = object_string_array(strategy, "preferred_sources")?;
    insert_terms(database, id, "source", &sources)?;
    Ok(())
}

fn insert_terms(
    database: &Transaction<'_>,
    id: &str,
    kind: &str,
    terms: &[String],
) -> CognitionResult<()> {
    for term in terms {
        insert_term(database, id, kind, term)?;
    }
    Ok(())
}

fn insert_term(
    database: &Transaction<'_>,
    id: &str,
    kind: &str,
    term: &str,
) -> CognitionResult<()> {
    database
        .execute(
            "INSERT OR IGNORE INTO knowhow_terms VALUES (?1, ?2, ?3)",
            params![id, term, kind],
        )
        .map_err(|_| error("memory_knowhow_index_write_failed"))?;
    Ok(())
}

fn string<'a>(value: &'a Value, field: &str) -> CognitionResult<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))
}

fn string_array(value: &Value, field: &str) -> CognitionResult<Vec<String>> {
    value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| error("memory_knowhow_entry_invalid"))
        })
        .collect()
}

fn object_string_array(
    value: &serde_json::Map<String, Value>,
    field: &str,
) -> CognitionResult<Vec<String>> {
    value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| error("memory_knowhow_entry_invalid"))
        })
        .collect()
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

fn create_private_file(path: &Path) -> CognitionResult<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| error("memory_knowhow_index_write_failed"))?;
    Ok(())
}

fn sync_directory(path: &Path) -> CognitionResult<()> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| error("memory_knowhow_index_write_failed"))?;
    Ok(())
}
