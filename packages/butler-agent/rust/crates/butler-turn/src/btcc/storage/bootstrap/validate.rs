mod activated;
mod references;

pub(super) use activated::read_activated;

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use super::manifest::{TABLES, digest, manifest_id};
use super::{StorageError, StorageResult, error};
use crate::btcc::StorageCode;

pub(super) fn empty_canonical_database(db: &Connection) -> StorageResult<()> {
    canonical_schema(db)?;
    for table in TABLES {
        let count: i64 = db
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .map_err(StorageError::sqlite)?;
        if count != 0 {
            return Err(error(StorageCode::AgentBtccStorageNonemptyFreshTarget));
        }
    }
    integrity(db)
}

pub(super) fn canonical_schema(db: &Connection) -> StorageResult<()> {
    let mut statement = db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'btcc_%' ORDER BY name")
        .map_err(StorageError::sqlite)?;
    let actual = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StorageError::sqlite)?;
    if actual.iter().map(String::as_str).collect::<Vec<_>>() != TABLES {
        return Err(error(StorageCode::AgentBtccStorageManifestMismatch));
    }
    Ok(())
}

pub(super) fn integrity(db: &Connection) -> StorageResult<()> {
    let quick: String = db
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(StorageError::sqlite)?;
    if quick != "ok" {
        return Err(error(StorageCode::AgentBtccStorageQuickCheckFailed));
    }
    let foreign: Option<i64> = db
        .query_row("PRAGMA foreign_key_check", [], |row| row.get(0))
        .optional()
        .map_err(StorageError::sqlite)?;
    if foreign.is_some() {
        return Err(error(StorageCode::AgentBtccStorageForeignKeyCheckFailed));
    }
    Ok(())
}

pub(super) fn receipt(db: &Connection, expected: &str) -> StorageResult<()> {
    empty_canonical_database(db)?;
    let (id, raw): (String, String) = db
        .query_row(
            "SELECT manifest_id,receipt_json FROM agent_storage_migration_receipt WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(StorageError::sqlite)?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|source| error(StorageCode::AgentBtccStorageReceiptInvalid).with_source(source))?;
    let tables = value["tables"]
        .as_array()
        .ok_or_else(|| error(StorageCode::AgentBtccStorageReceiptInvalid))?;
    let matching = id == expected
        && expected == manifest_id()
        && value["schema"] == "butler.agent-btcc-storage-migration.v1"
        && value["manifestId"] == expected
        && value["sourceKind"] == "fresh_install"
        && value["sourceSchemaVersion"] == 0
        && value["sourceSizeBytes"] == 0
        && value["fence"]["fenceId"]
            .as_str()
            .is_some_and(|v| !v.trim().is_empty())
        && value["fence"]["reconciledClaims"] == 0
        && value["fence"]["parkedClaims"] == 0
        && value["fence"]["claimDispositionSha256"] == digest(b"[]")
        && value["completedAt"].as_str().is_some_and(|v| !v.is_empty())
        && tables.len() == TABLES.len()
        && tables.iter().zip(TABLES).all(|(entry, name)| {
            entry["name"] == name && entry["rowCount"] == 0 && entry["contentSha256"] == digest(b"")
        });
    if !matching {
        return Err(error(StorageCode::AgentBtccStorageReceiptInvalid));
    }
    Ok(())
}

pub(super) fn readiness(db: &Connection, expected: &str) -> StorageResult<()> {
    receipt(db, expected)?;
    let (id, raw): (String, String) = db
        .query_row(
            "SELECT manifest_id,marker_json FROM agent_storage_activation_marker WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(StorageError::sqlite)?;
    let marker: Value = serde_json::from_str(&raw).map_err(|source| {
        error(StorageCode::AgentBtccStorageActivationInvalid).with_source(source)
    })?;
    if id != expected
        || marker["schema"] != "butler.agent-btcc-storage-activation.v1"
        || marker["manifestId"] != expected
        || marker["storageContract"] != "split-v1"
        || marker["firstActivatedAt"]
            .as_str()
            .is_none_or(str::is_empty)
        || marker["activatedAt"].as_str().is_none_or(str::is_empty)
    {
        return Err(error(StorageCode::AgentBtccStorageActivationInvalid));
    }
    Ok(())
}
