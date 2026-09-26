//! Source-compatible fresh-install BTCC publication and activation.

mod manifest;
mod validate;

use crate::btcc::StorageCode;
use std::fs::{self, File};
use std::path::Path;

use rusqlite::{Connection, params};
use serde_json::json;

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
pub(crate) fn bootstrap_fresh_storage(
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
    let result = (|| {
        let mut db = Connection::open(&temp).map_err(StorageError::sqlite)?;
        schema::create_current(&db).map_err(StorageError::sqlite)?;
        migration::apply(&mut db).map_err(StorageError::sqlite)?;
        db.execute_batch(METADATA_SCHEMA)
            .map_err(StorageError::sqlite)?;
        validate::empty_canonical_database(&db)?;

        // Fresh source has no rows or claims. Snapshot hashes are SHA256 of
        // the empty row stream; disposition is SHA256(JSON.stringify([])).
        let tables: Vec<_> = TABLES
            .iter()
            .map(|name| json!({"name": name, "rowCount": 0, "contentSha256": digest(b"")}))
            .collect();
        let receipt = json!({
            "schema": "butler.agent-btcc-storage-migration.v1",
            "manifestId": id,
            "sourceKind": "fresh_install",
            "sourceSchemaVersion": 0,
            "sourceSizeBytes": 0,
            "fence": {
                "fenceId": fence_id,
                "reconciledClaims": 0,
                "parkedClaims": 0,
                "claimDispositionSha256": digest(b"[]"),
            },
            "tables": tables,
            "completedAt": now_iso,
        });
        db.execute(
            "INSERT INTO agent_storage_migration_receipt (singleton,manifest_id,receipt_json) VALUES (1,?1,?2)",
            params![id, receipt.to_string()],
        )
        .map_err(StorageError::sqlite)?;
        validate::receipt(&db, &id)?;
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(StorageError::sqlite)?;
        db.close()
            .map_err(|(_, error)| StorageError::sqlite(error))?;
        File::open(&temp)
            .and_then(|file| file.sync_all())
            .map_err(io_error)?;
        if path.exists() {
            return Err(error(StorageCode::AgentBtccStoragePublishTargetExists));
        }
        fs::rename(&temp, path).map_err(io_error)?;
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(io_error)?;

        let db = Connection::open(path).map_err(StorageError::sqlite)?;
        validate::receipt(&db, &id)?;
        let marker = json!({
            "schema": "butler.agent-btcc-storage-activation.v1",
            "manifestId": id,
            "storageContract": "split-v1",
            "runtimeVersion": runtime_version,
            "firstActivatedAt": now_iso,
            "activatedAt": now_iso,
        });
        db.execute(
            "INSERT INTO agent_storage_activation_marker (singleton,manifest_id,marker_json) VALUES (1,?1,?2)",
            params![id, marker.to_string()],
        )
        .map_err(StorageError::sqlite)?;
        validate::readiness(&db, &id)?;
        db.close()
            .map_err(|(_, error)| StorageError::sqlite(error))?;
        Ok(id)
    })();
    if result.is_err() {
        // The published target is preserved, matching the source catch path.
        let _ = remove_temp(&temp);
    }
    result
}

/// Existing current-manifest target: inspect read-only, never repair or
/// fabricate the receipt/activation pair during startup.
pub(crate) fn read_activated_storage_manifest(path: &Path) -> StorageResult<String> {
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
