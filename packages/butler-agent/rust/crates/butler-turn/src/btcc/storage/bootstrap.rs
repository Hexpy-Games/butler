//! Source-compatible fresh-install BTCC publication and activation.

mod manifest;
mod validate;

use crate::btcc::StorageCode;
use std::fs::{self, File};
use std::path::Path;

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::{StorageError, StorageResult, migration, schema};
use manifest::{TABLES, digest, manifest_id};

const METADATA_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS agent_storage_migration_receipt (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  manifest_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_storage_activation_marker (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  manifest_id TEXT NOT NULL,
  marker_json TEXT NOT NULL
);";

/// Prepare and activate only a genuinely new Agent BTCC target. Existing
/// target/source migration remains owned by the legacy migration path.
pub fn bootstrap_fresh_storage(
    path: &Path,
    fence_id: &str,
    runtime_version: &str,
    now_iso: &str,
) -> StorageResult<String> {
    if fence_id.trim().is_empty() {
        return Err(error(StorageCode::AgentBtccStorageFenceInvalid));
    }
    if path.exists() {
        return Err(error(StorageCode::AgentBtccExistingStorageUnsupported));
    }
    let parent = path
        .parent()
        .ok_or_else(|| error(StorageCode::AgentBtccStoragePathInvalid))?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let temp = path.with_extension("sqlite.migration.tmp");
    remove_temp(&temp)?;
    let id = manifest_id();
    let fresh = FreshStorage {
        path,
        parent,
        temp: &temp,
        id: &id,
        fence_id,
        runtime_version,
        now_iso,
    };
    let result = fresh.prepare().and_then(|()| fresh.publish_and_activate());
    if result.is_err() {
        // The published target is preserved, matching the source catch path.
        let _ = remove_temp(&temp);
    }
    result.map(|()| id)
}

/// A fresh storage target being prepared in a temporary file and published.
struct FreshStorage<'a> {
    path: &'a Path,
    parent: &'a Path,
    temp: &'a Path,
    id: &'a str,
    fence_id: &'a str,
    runtime_version: &'a str,
    now_iso: &'a str,
}

impl FreshStorage<'_> {
    /// Creates the current schema in the temporary file and records the
    /// fresh-install migration receipt, then syncs it.
    fn prepare(&self) -> StorageResult<()> {
        let mut db = Connection::open(self.temp).map_err(StorageError::sqlite)?;
        schema::create_current(&db).map_err(StorageError::sqlite)?;
        migration::apply(&mut db).map_err(StorageError::sqlite)?;
        db.execute_batch(METADATA_SCHEMA)
            .map_err(StorageError::sqlite)?;
        validate::empty_canonical_database(&db)?;
        db.execute(
            "INSERT INTO agent_storage_migration_receipt (singleton,manifest_id,receipt_json) VALUES (1,?1,?2)",
            params![self.id, self.receipt().to_string()],
        )
        .map_err(StorageError::sqlite)?;
        validate::receipt(&db, self.id)?;
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(StorageError::sqlite)?;
        db.close()
            .map_err(|(_, error)| StorageError::sqlite(error))?;
        File::open(self.temp)
            .and_then(|file| file.sync_all())
            .map_err(io_error)
    }

    /// The fresh-install receipt. A fresh source has no rows or claims:
    /// snapshot hashes are SHA256 of the empty row stream and the claim
    /// disposition is SHA256(JSON.stringify([])).
    fn receipt(&self) -> Value {
        let tables: Vec<_> = TABLES
            .iter()
            .map(|name| json!({"name": name, "rowCount": 0, "contentSha256": digest(b"")}))
            .collect();
        json!({
            "schema": "butler.agent-btcc-storage-migration.v1",
            "manifestId": self.id,
            "sourceKind": "fresh_install",
            "sourceSchemaVersion": 0,
            "sourceSizeBytes": 0,
            "fence": {
                "fenceId": self.fence_id,
                "reconciledClaims": 0,
                "parkedClaims": 0,
                "claimDispositionSha256": digest(b"[]"),
            },
            "tables": tables,
            "completedAt": self.now_iso,
        })
    }

    /// Renames the prepared file into place (never over an existing
    /// target), then writes and validates the activation marker.
    fn publish_and_activate(&self) -> StorageResult<()> {
        if self.path.exists() {
            return Err(error(StorageCode::AgentBtccStoragePublishTargetExists));
        }
        fs::rename(self.temp, self.path).map_err(io_error)?;
        File::open(self.parent)
            .and_then(|file| file.sync_all())
            .map_err(io_error)?;
        let db = Connection::open(self.path).map_err(StorageError::sqlite)?;
        validate::receipt(&db, self.id)?;
        let marker = json!({
            "schema": "butler.agent-btcc-storage-activation.v1",
            "manifestId": self.id,
            "storageContract": "split-v1",
            "runtimeVersion": self.runtime_version,
            "firstActivatedAt": self.now_iso,
            "activatedAt": self.now_iso,
        });
        db.execute(
            "INSERT INTO agent_storage_activation_marker (singleton,manifest_id,marker_json) VALUES (1,?1,?2)",
            params![self.id, marker.to_string()],
        )
        .map_err(StorageError::sqlite)?;
        validate::readiness(&db, self.id)?;
        db.close()
            .map_err(|(_, error)| StorageError::sqlite(error))
    }
}

/// Existing current-manifest target: inspect read-only, never repair or
/// fabricate the receipt/activation pair during startup.
pub fn read_activated_storage_manifest(path: &Path) -> StorageResult<String> {
    validate::read_activated(path)
}

fn remove_temp(temp: &Path) -> StorageResult<()> {
    for path in [
        temp.to_path_buf(),
        temp.with_extension("tmp-wal"),
        temp.with_extension("tmp-shm"),
    ] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

fn error(code: StorageCode) -> StorageError {
    StorageError::new(code, code.as_str())
}

fn io_error(error: std::io::Error) -> StorageError {
    StorageError::new(StorageCode::AgentBtccStorageIoError, error.to_string()).with_source(error)
}
