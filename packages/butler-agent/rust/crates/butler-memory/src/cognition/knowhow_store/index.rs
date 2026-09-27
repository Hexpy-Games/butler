//! The KnowHow SQLite index (`index.sqlite`), rebuilt atomically from the
//! valid entries and the source-quality summaries.

use std::{
    fs::{self, OpenOptions},
    path::Path,
};

#[cfg(unix)]
use std::fs::File;

use rusqlite::{Connection, Transaction, params};

use crate::cognition::CognitionResult;

use super::document::{IntentMatch, KnowHowEntry};
use super::{entries, error, quality::SourceQualitySummary};
use crate::cognition::CognitionCode;
use crate::lenient::{Arg, Obj};

pub(super) fn rebuild(root: &Path, quality: &[SourceQualitySummary]) -> CognitionResult<usize> {
    ensure_private_dir(root)?;
    let entry_paths = entries::list_paths(root)?;
    let path = root.join("index.sqlite");
    let temporary = root.join(format!("index.sqlite.tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        create_private_file(&temporary)?;
        let mut database = Connection::open(&temporary).map_err(|source| {
            error(CognitionCode::MemoryKnowhowIndexWriteFailed).with_source(source)
        })?;
        create_schema(&database)?;
        let mut indexed = 0;
        for entry_path in &entry_paths {
            let entry = entries::read_one(root, entry_path)?.entry();
            if !entries::validate(&entry).is_empty() {
                continue;
            }
            let transaction = database.transaction().map_err(|source| {
                error(CognitionCode::MemoryKnowhowIndexWriteFailed).with_source(source)
            })?;
            insert_entry(&transaction, &entry)?;
            transaction.commit().map_err(|source| {
                error(CognitionCode::MemoryKnowhowIndexWriteFailed).with_source(source)
            })?;
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
                .map_err(|source| {
                    error(CognitionCode::MemoryKnowhowIndexWriteFailed).with_source(source)
                })?;
        }
        database.close().map_err(|(_, source)| {
            error(CognitionCode::MemoryKnowhowIndexWriteFailed).with_source(source)
        })?;
        fs::rename(&temporary, &path).map_err(|source| {
            error(CognitionCode::MemoryKnowhowIndexWriteFailed).with_source(source)
        })?;
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
        .map_err(|source| error(CognitionCode::MemoryKnowhowIndexWriteFailed).with_source(source))
}

/// One entry row and its name, alias, topic, example and source terms.
fn insert_entry(database: &Transaction<'_>, entry: &KnowHowEntry) -> CognitionResult<()> {
    let required = KnowHowEntry::required;
    let id = required(&entry.knowhow_id)?;
    let name = required(&entry.name)?;
    let status = required(&entry.status)?;
    let scope = required(&entry.scope)?;
    let summary = entry.summary.valid();
    let updated_at = required(&entry.updated_at)?;
    let quality = entry.quality()?;
    let score = number(&quality.score)?;
    let confidence = number(&quality.confidence)?;
    database
        .execute(
            "INSERT INTO knowhow_entries VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id, name, status, scope, summary, score, confidence, updated_at
            ],
        )
        .map_err(|source| {
            error(CognitionCode::MemoryKnowhowIndexWriteFailed).with_source(source)
        })?;

    insert_term(database, id, "name", name)?;
    insert_terms(
        database,
        id,
        "alias",
        &KnowHowEntry::strings(&entry.aliases)?,
    )?;
    let Arg::Valid(Obj(IntentMatch { topics, examples })) = &entry.intent_match else {
        return Err(error(CognitionCode::MemoryKnowhowEntryInvalid));
    };
    insert_terms(database, id, "topic", &KnowHowEntry::strings(topics)?)?;
    insert_terms(database, id, "example", &KnowHowEntry::strings(examples)?)?;
    insert_terms(database, id, "source", &entry.preferred_sources()?)?;
    Ok(())
}

fn number(value: &Arg<f64>) -> CognitionResult<f64> {
    value
        .valid()
        .copied()
        .ok_or_else(|| error(CognitionCode::MemoryKnowhowEntryInvalid))
}

fn insert_terms(
    database: &Transaction<'_>,
    id: &str,
    kind: &str,
    terms: &[&str],
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
        .map_err(|source| {
            error(CognitionCode::MemoryKnowhowIndexWriteFailed).with_source(source)
        })?;
    Ok(())
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

fn create_private_file(path: &Path) -> CognitionResult<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|source| {
        error(CognitionCode::MemoryKnowhowIndexWriteFailed).with_source(source)
    })?;
    Ok(())
}

fn sync_directory(path: &Path) -> CognitionResult<()> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| {
            error(CognitionCode::MemoryKnowhowIndexWriteFailed).with_source(source)
        })?;
    Ok(())
}
