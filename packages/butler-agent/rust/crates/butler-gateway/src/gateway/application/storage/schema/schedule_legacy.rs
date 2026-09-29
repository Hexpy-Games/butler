//! One-time import of the former DATA/automations JSON store.

use std::{fs, path::Path};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::Value;

use super::super::{AppStorageCode, AppStorageError};
use crate::gateway::application::settings::{access_mode_name, conversation_access_mode};

const MARKER: &str = "schedule_json_import_v1";
const LEGACY_SCHEDULE_MARKERS: [&str; 6] = [
    "schedule",
    "prompt",
    "session_id",
    "next_run_at",
    "last_run_at",
    "run_count",
];

#[derive(Deserialize)]
struct LegacyRecord {
    id: String,
    title: String,
    prompt: String,
    session_id: String,
    status: String,
    schedule: LegacyTiming,
    next_run_at: Option<String>,
    last_run_at: Option<String>,
    run_count: u64,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum LegacyTiming {
    Once {
        run_at: String,
    },
    Interval {
        interval_minutes: i64,
        start_at: Option<String>,
    },
}

pub(super) fn migrate(
    db: &mut Connection,
    data_root: Option<&Path>,
) -> Result<(), AppStorageError> {
    let Some(data_root) = data_root else {
        return Ok(());
    };
    let marker: Option<String> = db
        .query_row(
            "SELECT value_json FROM app_settings WHERE key=?1",
            [MARKER],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if marker.is_some() {
        return Ok(());
    }
    let directory = data_root.join("automations");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => {
            return Err(import_error(std::io::Error::other(
                "Legacy schedule directory is not a real directory",
            )));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return mark_empty(db),
        Err(error) => return Err(import_error(error)),
    }
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) => return Err(import_error(error)),
    };
    let mut files = entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(import_error)?;
    files.sort_by_key(fs::DirEntry::file_name);
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(AppStorageError::sqlite)?;
    let marker: Option<String> = tx
        .query_row(
            "SELECT value_json FROM app_settings WHERE key=?1",
            [MARKER],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if marker.is_some() {
        return Ok(());
    }
    let mut count = 0;
    for entry in files {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let metadata = fs::symlink_metadata(&path).map_err(import_error)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let Some((raw, record)) = read_legacy_record(&path)? else {
            continue;
        };
        if path.file_stem().and_then(|value| value.to_str()) != Some(record.id.as_str()) {
            continue;
        }
        insert(&tx, &record, &raw)?;
        count += 1;
    }
    tx.execute(
        "INSERT INTO app_settings(key,value_json,updated_at) VALUES(?1,?2,datetime('now'))",
        params![MARKER, count.to_string()],
    )
    .map_err(AppStorageError::sqlite)?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    eprintln!("[schedule-migration] imported {count} legacy records; source files retained");
    Ok(())
}

fn mark_empty(db: &Connection) -> Result<(), AppStorageError> {
    db.execute(
        "INSERT OR IGNORE INTO app_settings(key,value_json,updated_at) VALUES(?1,'0',datetime('now'))",
        [MARKER],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

fn read_legacy_record(path: &Path) -> Result<Option<(String, LegacyRecord)>, AppStorageError> {
    let raw = fs::read_to_string(path).map_err(import_error)?;
    let value: Value = serde_json::from_str(&raw).map_err(import_error)?;
    let is_schedule = value.as_object().is_some_and(|object| {
        LEGACY_SCHEDULE_MARKERS
            .iter()
            .any(|field| object.contains_key(*field))
    });
    if !is_schedule {
        return Ok(None);
    }
    let record = serde_json::from_value(value).map_err(import_error)?;
    Ok(Some((raw, record)))
}

fn insert(db: &Connection, record: &LegacyRecord, raw: &str) -> Result<(), AppStorageError> {
    let target: Option<(String, String)> = db
        .query_row(
            "SELECT id,kind FROM chats WHERE id=?1 OR conversation_session_id=?1 LIMIT 1",
            [&record.session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let resolved = target.is_some() || record.session_id == "butler/main";
    let (target_id, target_kind) = target.unwrap_or_else(|| ("general".into(), "chat".into()));
    let access = access_mode_name(&conversation_access_mode(db, &target_id)?);
    let id = unique_id(db, &record.id)?;
    let (kind, seconds, run_at, start_at) = match &record.schedule {
        LegacyTiming::Once { run_at } => ("once", 0, Some(run_at.as_str()), None),
        LegacyTiming::Interval {
            interval_minutes,
            start_at,
        } => (
            "interval",
            interval_minutes.saturating_mul(60),
            None,
            start_at.as_deref(),
        ),
    };
    let state = match record.status.as_str() {
        "active" if resolved => "enabled",
        "deleted" => "deleted",
        _ => "paused",
    };
    db.execute("INSERT INTO app_automations(id,title,prompt_body,target_kind,target_session_id,interval_seconds,schedule_type,run_at,start_at,legacy_record_json,access_mode,state,next_run_at,last_run_at,last_run_state,run_count,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'never_run',?15,?16,?17)",
        params![id,record.title,record.prompt,target_kind,target_id,seconds,kind,run_at,start_at,raw,access,state,record.next_run_at,record.last_run_at,i64::try_from(record.run_count).unwrap_or(i64::MAX),record.created_at,record.updated_at]
    ).map_err(AppStorageError::sqlite)?;
    Ok(())
}

fn unique_id(db: &Connection, original: &str) -> Result<String, AppStorageError> {
    let mut suffix = 0u64;
    loop {
        let candidate = match suffix {
            0 => original.to_owned(),
            1 => format!("legacy-{original}"),
            _ => format!("legacy-{original}-{suffix}"),
        };
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM app_automations WHERE id=?1)",
                [&candidate],
                |row| row.get(0),
            )
            .map_err(AppStorageError::sqlite)?;
        if !exists {
            return Ok(candidate);
        }
        suffix = suffix.checked_add(1).ok_or_else(|| {
            AppStorageError::new(
                AppStorageCode::AppSchemaJsonFailed,
                "Legacy schedule ID space exhausted",
            )
        })?;
    }
}

fn import_error(error: impl std::error::Error + Send + Sync + 'static) -> AppStorageError {
    AppStorageError::new(AppStorageCode::AppSchemaJsonFailed, error.to_string()).with_source(error)
}
