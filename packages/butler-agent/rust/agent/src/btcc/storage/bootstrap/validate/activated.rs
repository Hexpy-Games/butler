//! Read-only readiness validation for a previously activated current manifest.

use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;

use super::super::manifest::{TABLES, manifest_id};
use super::{StorageError, StorageResult, canonical_schema, error, integrity, references};

pub(crate) fn read_activated(path: &Path) -> StorageResult<String> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(StorageError::sqlite)?;
    let expected = manifest_id();
    let (receipt_id, receipt_raw) = marker_row(
        &db,
        "agent_storage_migration_receipt",
        "receipt_json",
        "agent_btcc_storage_unreceipted_target",
    )?;
    if receipt_id != expected {
        return Err(error("agent_btcc_storage_manifest_mismatch"));
    }
    let receipt: Value = serde_json::from_str(&receipt_raw)
        .map_err(|_| error("agent_btcc_storage_receipt_invalid"))?;
    validate_receipt(&receipt, &expected)?;
    canonical_schema(&db)?;
    integrity(&db)?;
    references::validate(&db)?;
    let (marker_id, marker_raw) = marker_row(
        &db,
        "agent_storage_activation_marker",
        "marker_json",
        "agent_btcc_storage_activation_missing",
    )?;
    let marker: Value = serde_json::from_str(&marker_raw)
        .map_err(|_| error("agent_btcc_storage_activation_invalid"))?;
    if marker_id != expected
        || marker["schema"] != "butler.agent-btcc-storage-activation.v1"
        || marker["manifestId"] != expected
        || marker["storageContract"] != "split-v1"
        || !nonempty(&marker["firstActivatedAt"])
        || !nonempty(&marker["activatedAt"])
    {
        return Err(error("agent_btcc_storage_activation_invalid"));
    }
    Ok(expected)
}

fn marker_row(
    db: &Connection,
    table: &str,
    column: &str,
    missing: &'static str,
) -> StorageResult<(String, String)> {
    let present = db
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .is_some();
    if !present {
        return Err(error(missing));
    }
    db.query_row(
        &format!("SELECT manifest_id,{column} FROM {table} WHERE singleton=1"),
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(StorageError::sqlite)?
    .ok_or_else(|| error(missing))
}

fn validate_receipt(value: &Value, expected: &str) -> StorageResult<()> {
    let fence = &value["fence"];
    let tables = value["tables"]
        .as_array()
        .ok_or_else(|| error("agent_btcc_storage_receipt_invalid"))?;
    let source_kind = value["sourceKind"].as_str();
    let completed_at = value["completedAt"]
        .as_str()
        .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok());
    let valid = value["schema"] == "butler.agent-btcc-storage-migration.v1"
        && value["manifestId"] == expected
        && matches!(source_kind, Some("fresh_install" | "legacy_app_db"))
        && safe_integer(&value["sourceSchemaVersion"])
        && safe_integer(&value["sourceSizeBytes"])
        && nonempty(&fence["fenceId"])
        && safe_integer(&fence["reconciledClaims"])
        && safe_integer(&fence["parkedClaims"])
        && fence["parkedClaims"].as_u64() <= fence["reconciledClaims"].as_u64()
        && digest(&fence["claimDispositionSha256"])
        && completed_at.is_some()
        && tables.len() == TABLES.len()
        && tables.iter().zip(TABLES).all(|(table, name)| {
            table["name"] == name
                && safe_integer(&table["rowCount"])
                && digest(&table["contentSha256"])
        });
    if !valid {
        return Err(error("agent_btcc_storage_receipt_invalid"));
    }
    Ok(())
}

fn safe_integer(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|number| number <= 9_007_199_254_740_991)
}

fn digest(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        text.len() == 64
            && text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !text.trim().is_empty())
}
