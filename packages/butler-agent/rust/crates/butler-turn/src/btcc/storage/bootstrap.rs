//! Source-compatible fresh-install BTCC publication and activation.

mod manifest;
mod validate;

use crate::btcc::StorageCode;
use butler_platform::sqlite;
use std::fs;
use std::path::Path;

use rusqlite::params;
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
    let temp = path.with_extension(format!(
        "sqlite.migration.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    butler_platform::secure_fs::owner_only(&mut options);
    drop(options.open(&temp).map_err(io_error)?);
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
    // Only this attempt's files are removed; a peer's preparation is untouched.
    let cleanup = remove_temp(&temp);
    result?;
    cleanup?;
    Ok(id)
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
        let mut db = sqlite::open(self.temp).map_err(StorageError::sqlite)?;
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
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(StorageError::sqlite)?;
        db.close()
            .map_err(|(_, error)| StorageError::sqlite(error))?;
        butler_platform::secure_fs::sync_path(self.temp).map_err(io_error)
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

    /// Publishes a fully activated, synced database without replacing a peer.
    fn publish_and_activate(&self) -> StorageResult<()> {
        publish(self.temp, self.path, || {}).map_err(|source| {
            if source.kind() == std::io::ErrorKind::AlreadyExists {
                error(StorageCode::AgentBtccStoragePublishTargetExists)
            } else {
                io_error(source)
            }
        })?;
        butler_platform::secure_fs::sync_path(self.parent).map_err(io_error)
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

fn publish(temp: &Path, path: &Path, before_publish: impl FnOnce()) -> std::io::Result<()> {
    if path.exists() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }
    before_publish();
    fs::hard_link(temp, path)
}

#[cfg(test)]
pub(super) fn publication_regression() {
    let root = std::env::temp_dir().join(format!("bootstrap-race-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let temp = root.join("prepared");
    let target = root.join("published");
    fs::write(&temp, b"ours").unwrap();
    let result = publish(&temp, &target, || {
        fs::write(&target, b"peer").unwrap();
    });
    assert_eq!(
        result.unwrap_err().kind(),
        std::io::ErrorKind::AlreadyExists
    );
    assert_eq!(fs::read(&target).unwrap(), b"peer");
    let peer_temp = root.join("fresh.sqlite.migration.tmp");
    fs::write(&peer_temp, b"peer still preparing").unwrap();
    let target = root.join("fresh.sqlite");
    let id = bootstrap_fresh_storage(&target, "fence", "test", "2026-09-30T00:00:00Z").unwrap();
    assert_eq!(read_activated_storage_manifest(&target).unwrap(), id);
    assert_eq!(fs::read(&peer_temp).unwrap(), b"peer still preparing");
    fs::remove_dir_all(root).unwrap();
}
