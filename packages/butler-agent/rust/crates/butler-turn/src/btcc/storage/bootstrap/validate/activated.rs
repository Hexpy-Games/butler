//! Read-only readiness validation for a previously activated current manifest.

use butler_core::json;
use butler_platform::sqlite;
use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;

use super::super::manifest::{TABLES, manifest_id};
use super::{StorageError, StorageResult, canonical_schema, error, integrity, references};
use crate::btcc::StorageCode;

pub(crate) fn read_activated(path: &Path) -> StorageResult<String> {
    read(
        path,
        true,
        tokio_util::sync::CancellationToken::new(),
        false,
    )
}

pub(crate) fn read(
    path: &Path,
    full: bool,
    cancellation: tokio_util::sync::CancellationToken,
    deferred: bool,
) -> StorageResult<String> {
    let started = std::time::Instant::now();
    trace("activated_begin", started);
    let db = open_validation(path, full, cancellation, deferred, started)?;
    let expected = manifest_id();
    let (receipt_id, receipt_raw) = marker_row(
        &db,
        "agent_storage_migration_receipt",
        "receipt_json",
        StorageCode::AgentBtccStorageUnreceiptedTarget,
    )?;
    if receipt_id != expected {
        return Err(error(StorageCode::AgentBtccStorageManifestMismatch));
    }
    let receipt: Value = serde_json::from_str(&receipt_raw)
        .map_err(|source| error(StorageCode::AgentBtccStorageReceiptInvalid).with_source(source))?;
    validate_receipt(&receipt, &expected)?;
    canonical_schema(&db)?;
    trace("schema_validated", started);
    if full {
        trace("full_validation_begin", started);
        integrity(&db)?;
        trace("integrity_validated", started);
        references::validate(&db)?;
        trace("references_validated", started);
    }
    let (marker_id, marker_raw) = marker_row(
        &db,
        "agent_storage_activation_marker",
        "marker_json",
        StorageCode::AgentBtccStorageActivationMissing,
    )?;
    let marker: Value = serde_json::from_str(&marker_raw).map_err(|source| {
        error(StorageCode::AgentBtccStorageActivationInvalid).with_source(source)
    })?;
    if marker_id != expected
        || *json::at(&marker, "/schema") != "butler.agent-btcc-storage-activation.v1"
        || *json::at(&marker, "/manifestId") != expected
        || *json::at(&marker, "/storageContract") != "split-v1"
        || !nonempty(json::at(&marker, "/firstActivatedAt"))
        || !nonempty(json::at(&marker, "/activatedAt"))
    {
        return Err(error(StorageCode::AgentBtccStorageActivationInvalid));
    }
    trace("cheap_validation_complete", started);
    Ok(expected)
}

fn trace_mapping(db: &Connection, started: std::time::Instant) -> StorageResult<()> {
    let mapped: i64 = db
        .pragma_query_value(None, "mmap_size", |row| row.get(0))
        .map_err(StorageError::sqlite)?;
    let cap: bool = db
        .query_row(
            "SELECT sqlite_compileoption_used('MAX_MMAP_SIZE=8589934592LL')",
            [],
            |row| row.get(0),
        )
        .map_err(StorageError::sqlite)?;
    trace(
        &format!("validation_mapping bytes={mapped} cap_8g={cap}"),
        started,
    );
    Ok(())
}

/// Read-only diagnostics for isolated startup qualification; never logs row data.
pub(in crate::btcc::storage) fn trace(phase: &str, started: std::time::Instant) {
    if matches!(
        std::env::var("BUTLER_E2E_TIER").as_deref(),
        Ok("stub" | "perf")
    ) && std::env::var("BUTLER_E2E_STARTUP_TRACE").as_deref() == Ok("1")
    {
        butler_core::diagnostic!(
            "[btcc-startup] phase={phase} elapsed_us={}",
            started.elapsed().as_micros()
        );
    }
}

fn marker_row(
    db: &Connection,
    table: &str,
    column: &str,
    missing: StorageCode,
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

// Passthrough: parse boundary validating untyped JSON into typed values.
fn validate_receipt(value: &Value, expected: &str) -> StorageResult<()> {
    let fence = &json::at(value, "/fence");
    let tables = json::at(value, "/tables")
        .as_array()
        .ok_or_else(|| error(StorageCode::AgentBtccStorageReceiptInvalid))?;
    let source_kind = json::at(value, "/sourceKind").as_str();
    let completed_at = json::at(value, "/completedAt")
        .as_str()
        .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok());
    let valid = *json::at(value, "/schema") == "butler.agent-btcc-storage-migration.v1"
        && *json::at(value, "/manifestId") == expected
        && matches!(source_kind, Some("fresh_install" | "legacy_app_db"))
        && safe_integer(json::at(value, "/sourceSchemaVersion"))
        && safe_integer(json::at(value, "/sourceSizeBytes"))
        && nonempty(json::at(fence, "/fenceId"))
        && safe_integer(json::at(fence, "/reconciledClaims"))
        && safe_integer(json::at(fence, "/parkedClaims"))
        && json::at(fence, "/parkedClaims").as_u64()
            <= json::at(fence, "/reconciledClaims").as_u64()
        && digest(json::at(fence, "/claimDispositionSha256"))
        && completed_at.is_some()
        && tables.len() == TABLES.len()
        && tables.iter().zip(TABLES).all(|(table, name)| {
            *json::at(table, "/name") == name
                && safe_integer(json::at(table, "/rowCount"))
                && digest(json::at(table, "/contentSha256"))
        });
    if !valid {
        return Err(error(StorageCode::AgentBtccStorageReceiptInvalid));
    }
    Ok(())
}

// Passthrough: parse boundary validating untyped JSON into typed values.
fn safe_integer(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|number| number <= 9_007_199_254_740_991)
}

// Passthrough: parse boundary validating untyped JSON into typed values.
fn digest(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        text.len() == 64
            && text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

// Passthrough: parse boundary validating untyped JSON into typed values.
fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !text.trim().is_empty())
}

fn open_validation(
    path: &Path,
    full: bool,
    cancellation: tokio_util::sync::CancellationToken,
    deferred: bool,
    started: std::time::Instant,
) -> StorageResult<Connection> {
    // Whole-file prefetch is not interruptible; reserve it for mandatory
    // synchronous checks. Deferred reads yield through the SQLite hook.
    if full && !deferred {
        sqlite::advise_validation_scan(path);
    }
    let db = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(StorageError::sqlite)?;
    db.progress_handler(
        10_000,
        Some(move || {
            if cancellation.is_cancelled() {
                return true;
            }
            // Cooperative I/O pacing only on the deferred worker, never Tokio.
            if deferred {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            false
        }),
    );
    // Full validation revisits overflow pages. Both the bounded page cache and
    // host-specific mapping belong only to this startup connection. Complete
    // quick/FK/reference checks still run; closing releases all retained pages.
    db.pragma_update(None, "cache_size", -65_536_i64)
        .map_err(StorageError::sqlite)?;
    db.pragma_update(None, "mmap_size", sqlite::VALIDATION_MMAP_BYTES)
        .map_err(StorageError::sqlite)?;
    trace_mapping(&db, started)?;
    Ok(db)
}
