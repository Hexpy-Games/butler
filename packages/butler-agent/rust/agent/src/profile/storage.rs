use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::contracts::{
    ClearProfilingResult, ProfileError, ProfileResult, ProfilingConsentSnapshot, ProfilingMode,
    RuntimeProfileProjection,
};

pub(super) const CONSENT_VERSION: &str = "2026-05-16";

pub(super) fn database_path(data_root: &Path) -> PathBuf {
    data_root.join("cognition/profile/profile.sqlite")
}

pub(super) fn open(data_root: &Path, create: bool) -> ProfileResult<Connection> {
    let path = database_path(data_root);
    if create {
        fs::create_dir_all(data_root.join("cognition/profile")).map_err(io_error)?;
    }
    let flags = if create {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db = Connection::open_with_flags(&path, flags).map_err(db_error)?;
    if create {
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(db_error)?;
        migrate(&db)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
    } else {
        db.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(db_error)?;
    }
    Ok(db)
}

fn migrate(db: &Connection) -> ProfileResult<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS profile_meta(
           key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS profile_candidates(
           id TEXT PRIMARY KEY,category TEXT NOT NULL,payload_json TEXT NOT NULL,
           source_type TEXT NOT NULL,confidence TEXT NOT NULL,
           sensitive_domain INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,expires_or_decay TEXT);
         CREATE TABLE IF NOT EXISTS stable_profile_entries(
           id TEXT PRIMARY KEY,category TEXT NOT NULL,payload_json TEXT NOT NULL,
           confidence TEXT NOT NULL,source_type TEXT NOT NULL,
           created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS runtime_projection(
           id TEXT PRIMARY KEY,version INTEGER NOT NULL,mode TEXT NOT NULL,
           payload_json TEXT NOT NULL,updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS profile_source_coverage(
           coverage_key TEXT PRIMARY KEY,message_id TEXT NOT NULL,source_hash TEXT NOT NULL,
           part_id TEXT NOT NULL,part_index INTEGER NOT NULL,scalar_pointer TEXT NOT NULL,
           byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,
           extractor_version TEXT NOT NULL,observed_at TEXT NOT NULL,
           evidence_ref TEXT NOT NULL UNIQUE,
           disposition TEXT NOT NULL CHECK(disposition IN ('pending','failed','complete')),
           failure_code TEXT,usage_json TEXT,owner_pid INTEGER,owner_nonce TEXT,
           claimed_at TEXT,updated_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS profile_source_coverage_disposition_idx
           ON profile_source_coverage(disposition,observed_at,coverage_key);",
    )
    .map_err(db_error)?;
    ensure_column(
        db,
        "profile_candidates",
        "status",
        "status TEXT NOT NULL DEFAULT 'candidate'",
    )?;
    ensure_column(db, "profile_candidates", "promoted_at", "promoted_at TEXT")?;
    ensure_column(
        db,
        "profile_source_coverage",
        "owner_pid",
        "owner_pid INTEGER",
    )?;
    ensure_column(
        db,
        "profile_source_coverage",
        "owner_nonce",
        "owner_nonce TEXT",
    )?;
    ensure_column(
        db,
        "profile_source_coverage",
        "claimed_at",
        "claimed_at TEXT",
    )
}

fn ensure_column(db: &Connection, table: &str, name: &str, definition: &str) -> ProfileResult<()> {
    let mut statement = db
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(db_error)?;
    let exists = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?
        .filter_map(Result::ok)
        .any(|column| column == name);
    if !exists {
        db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {definition}"))
            .map_err(db_error)?;
    }
    Ok(())
}

pub(super) fn default_consent() -> ProfilingConsentSnapshot {
    ProfilingConsentSnapshot {
        mode: ProfilingMode::Off,
        consent_version: CONSENT_VERSION.into(),
        consented_at: None,
        raw_profile_browser_visible: false,
    }
}

pub(super) fn read_consent(data_root: &Path) -> ProfilingConsentSnapshot {
    if !database_path(data_root).exists() {
        return default_consent();
    }
    let Ok(db) = open(data_root, false) else {
        return default_consent();
    };
    let result = (|| -> ProfileResult<_> {
        let mut statement = db
            .prepare("SELECT key,value_json FROM profile_meta")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?;
        let mut values = Map::new();
        for row in rows {
            let (key, raw) = row.map_err(db_error)?;
            values.insert(key, serde_json::from_str(&raw).unwrap_or(Value::Null));
        }
        let mode = values
            .get("mode")
            .and_then(Value::as_str)
            .map(ProfilingMode::parse)
            .unwrap_or(ProfilingMode::Off);
        Ok(ProfilingConsentSnapshot {
            mode,
            consent_version: values
                .get("consent_version")
                .and_then(Value::as_str)
                .unwrap_or(CONSENT_VERSION)
                .to_owned(),
            consented_at: if mode == ProfilingMode::Off {
                None
            } else {
                values
                    .get("consented_at")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            },
            raw_profile_browser_visible: false,
        })
    })();
    result.unwrap_or_else(|_| default_consent())
}

pub(super) fn write_consent(
    data_root: &Path,
    mode: ProfilingMode,
    consent_version: Option<&str>,
    consented_at: Option<&str>,
    now: &str,
) -> ProfileResult<ProfilingConsentSnapshot> {
    let snapshot = ProfilingConsentSnapshot {
        mode,
        consent_version: consent_version.unwrap_or(CONSENT_VERSION).to_owned(),
        consented_at: (mode != ProfilingMode::Off).then(|| consented_at.unwrap_or(now).to_owned()),
        raw_profile_browser_visible: false,
    };
    let db = open(data_root, true)?;
    let values = [
        ("mode", json!(snapshot.mode)),
        ("consent_version", json!(snapshot.consent_version)),
        ("consented_at", json!(snapshot.consented_at)),
        ("raw_profile_browser_visible", json!(false)),
    ];
    for (key, value) in values {
        db.execute(
            "INSERT INTO profile_meta(key,value_json,updated_at) VALUES(?1,?2,?3)
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            params![key, serde_json::to_string(&value).map_err(json_error)?, now],
        ).map_err(db_error)?;
    }
    if mode == ProfilingMode::Off {
        db.execute("DELETE FROM runtime_projection", [])
            .map_err(db_error)?;
    }
    Ok(snapshot)
}

pub(super) fn clear(data_root: &Path) -> ProfileResult<ClearProfilingResult> {
    let db = open(data_root, true)?;
    let count = |table: &str| -> ProfileResult<usize> {
        db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get::<_, i64>(0)
        })
        .map(|value| value.max(0) as usize)
        .map_err(db_error)
    };
    let result = ClearProfilingResult {
        removed_candidates: count("profile_candidates")?,
        removed_stable_entries: count("stable_profile_entries")?,
        removed_runtime_projections: count("runtime_projection")?,
    };
    db.execute_batch(
        "DELETE FROM profile_candidates; DELETE FROM stable_profile_entries;
         DELETE FROM runtime_projection; DELETE FROM profile_source_coverage;
         DELETE FROM profile_meta WHERE key='source_scan_offset';",
    )
    .map_err(db_error)?;
    Ok(result)
}

pub(super) fn write_projection(
    data_root: &Path,
    value: &RuntimeProfileProjection,
) -> ProfileResult<()> {
    let db = open(data_root, true)?;
    db.execute(
        "INSERT INTO runtime_projection(id,version,mode,payload_json,updated_at)
         VALUES('active',?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET
         version=excluded.version,mode=excluded.mode,payload_json=excluded.payload_json,updated_at=excluded.updated_at",
        params![value.version as i64, value.mode, serde_json::to_string(value).map_err(json_error)?, value.updated_at],
    ).map_err(db_error)?;
    Ok(())
}

pub(super) fn delete_projection(data_root: &Path) -> ProfileResult<()> {
    if !database_path(data_root).exists() {
        return Ok(());
    }
    open(data_root, true)?
        .execute("DELETE FROM runtime_projection", [])
        .map_err(db_error)?;
    Ok(())
}

pub(super) fn read_projection(data_root: &Path) -> ProfileResult<Option<RuntimeProfileProjection>> {
    if !database_path(data_root).exists() {
        return Ok(None);
    }
    let db = open(data_root, false)?;
    let raw = db
        .query_row(
            "SELECT payload_json FROM runtime_projection WHERE id='active' LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(json_error))
        .transpose()
}

#[derive(Clone)]
pub(super) struct StoredEntry {
    pub id: String,
    pub category: String,
    pub source_type: String,
    pub payload: Value,
    pub updated_at: String,
}

pub(super) fn stable_entries(data_root: &Path) -> ProfileResult<Vec<StoredEntry>> {
    if !database_path(data_root).exists() {
        return Ok(Vec::new());
    }
    let db = open(data_root, false)?;
    stable_entries_in_db(&db)
}

pub(super) fn stable_entries_in_db(db: &Connection) -> ProfileResult<Vec<StoredEntry>> {
    let mut statement = db
        .prepare(
            "SELECT id,category,source_type,payload_json,updated_at
         FROM stable_profile_entries ORDER BY updated_at DESC,id ASC",
        )
        .map_err(db_error)?;
    statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(db_error)?
        .map(|row| {
            let (id, category, source_type, raw, updated_at) = row.map_err(db_error)?;
            Ok(StoredEntry {
                id,
                category,
                source_type,
                payload: serde_json::from_str(&raw).map_err(json_error)?,
                updated_at,
            })
        })
        .collect()
}

pub(super) fn db_error(_: rusqlite::Error) -> ProfileError {
    ProfileError::new("profile_store_unavailable", "Profile store is unavailable.")
}
fn io_error(_: std::io::Error) -> ProfileError {
    ProfileError::new("profile_store_unavailable", "Profile store is unavailable.")
}
fn json_error(_: serde_json::Error) -> ProfileError {
    ProfileError::new("profile_data_invalid", "Profile data is invalid.")
}
