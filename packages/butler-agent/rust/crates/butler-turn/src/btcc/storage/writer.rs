//! Own the BTCC writer connection and drain its checkpoint worker before close.
use super::{
    DatabaseOperation, ProcessLiveness, RuntimeOwnerIdentity, StorageActivation, StorageCode,
    StorageError, StorageProfile, StorageResult, bootstrap, legacy_cutover,
    runtime_owner::RuntimeOwner, timing,
};
use butler_platform::sqlite;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::{path::Path, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot};

pub(super) fn run_connection_lane(
    path: &Path,
    profile: StorageProfile,
    activation: &StorageActivation,
    identity: RuntimeOwnerIdentity,
    liveness: Arc<dyn ProcessLiveness>,
    mut receiver: mpsc::Receiver<DatabaseOperation>,
    initialized: oneshot::Sender<StorageResult<(String, u64)>>,
) -> StorageResult<()> {
    let setup = (|| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                StorageError::new(StorageCode::SqliteParentCreateFailed, error.to_string())
                    .with_source(error)
            })?;
        }
        let mut connection = sqlite::open(path).map_err(StorageError::sqlite)?;
        butler_work::cutover::check_epoch(&connection).map_err(|e| StorageError::Port {
            code: "work_model_newer_writer_epoch",
            message: e.to_string(),
            source: None,
        })?;
        configure(&connection, profile)?;
        timing::install_writer(&connection);
        validate_activation(&connection, activation)?;
        bootstrap::migrate_current(&mut connection)?;
        legacy_cutover::apply(&mut connection)?;
        let checkpoint = super::checkpoint::CheckpointOwner::start(&connection)?;
        let owner = RuntimeOwner::register(&mut connection, identity, liveness)?;
        StorageResult::Ok((connection, owner, checkpoint))
    })();
    let (mut connection, owner, checkpoint) = match setup {
        Ok(value) => value,
        Err(error) => {
            let _ignored_closed_opener = initialized.send(Err(error.clone()));
            return Err(error);
        }
    };
    sqlite::sync_wal_index(&connection).map_err(|error| {
        StorageError::new(StorageCode::SqliteWalSyncFailed, error.to_string()).with_source(error)
    })?;
    if initialized
        .send(Ok((owner.owner_id().to_owned(), owner.generation())))
        .is_err()
    {
        return close(connection, &owner, checkpoint);
    }
    while let Some(operation) = receiver.blocking_recv() {
        if let Some(checkpoint) = &checkpoint {
            checkpoint.lane_busy();
        }
        operation(&mut connection, &owner);
        if receiver.is_empty()
            && let Some(checkpoint) = &checkpoint
        {
            checkpoint.lane_idle();
        }
    }
    close(connection, &owner, checkpoint)
}

pub(super) fn close(
    connection: sqlite::Connection,
    owner: &RuntimeOwner,
    checkpoint: Option<super::checkpoint::CheckpointOwner>,
) -> StorageResult<()> {
    let checkpoint = checkpoint.map_or(Ok(()), super::checkpoint::CheckpointOwner::close);
    // Evaluate every step before combining results; the earliest failure wins.
    let released = owner.close(&connection);
    let transaction = if connection.is_autocommit() {
        Ok(())
    } else {
        Err(StorageError::new(
            StorageCode::SqliteTransactionOpenAtClose,
            "BTCC database transaction remained open at close",
        ))
    };
    // NORMAL commits are durable once the WAL is synced. Keep it for recovery
    // instead of copying and syncing the same pages again at final close.
    let synced = sqlite::sync_wal(&connection).map_err(|error| {
        StorageError::new(StorageCode::SqliteWalSyncFailed, error.to_string()).with_source(error)
    });
    let configured = if synced.is_ok() {
        connection
            .set_db_config(
                rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
                true,
            )
            .map(|_| ())
            .map_err(StorageError::sqlite)
    } else {
        Ok(())
    };
    let path = connection.path().map(std::path::PathBuf::from);
    let closed = connection
        .close()
        .map_err(|(_, error)| StorageError::sqlite(error));
    if let Some(path) = path {
        bootstrap::refresh_after_close(&path);
    }
    checkpoint
        .and(released)
        .and(transaction)
        .and(synced)
        .and(configured)
        .and(closed)
}

pub(super) fn configure(connection: &Connection, profile: StorageProfile) -> StorageResult<()> {
    // The writer no longer serves request reads. Bound its page cache so adding
    // independent readers does not retain SQLite's default 2 MiB writer cache.
    connection
        .pragma_update(None, "cache_size", -512)
        .map_err(StorageError::sqlite)?;
    connection
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(StorageError::sqlite)?;
    connection
        .pragma_update(
            None,
            "journal_mode",
            match profile {
                StorageProfile::Durable => "WAL",
                #[cfg(any(test, feature = "test-support"))]
                StorageProfile::Ephemeral => "DELETE",
            },
        )
        .map_err(StorageError::sqlite)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(StorageError::sqlite)?;
    // Applied only at WAL reset/checkpoint, without a periodic idle writer.
    connection
        .pragma_update(None, "journal_size_limit", 16_777_216_i64)
        .map_err(StorageError::sqlite)?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(StorageError::sqlite)
}

fn validate_activation(
    connection: &Connection,
    activation: &StorageActivation,
) -> StorageResult<()> {
    let receipt = storage_marker(
        connection,
        "agent_storage_migration_receipt",
        "receipt_json",
    )?
    .ok_or_else(|| {
        StorageError::new(
            StorageCode::AgentBtccStorageReceiptMissing,
            "missing receipt",
        )
    })?;
    let marker = storage_marker(connection, "agent_storage_activation_marker", "marker_json")?
        .ok_or_else(|| {
            StorageError::new(
                StorageCode::AgentBtccStorageActivationMissing,
                "missing marker",
            )
        })?;
    let receipt_json = parse_marker(&receipt.1, StorageCode::AgentBtccStorageReceiptInvalid)?;
    let marker_json = parse_marker(&marker.1, StorageCode::AgentBtccStorageActivationInvalid)?;
    let valid = receipt.0 == activation.manifest_id
        && marker.0 == activation.manifest_id
        && receipt_json.get("manifestId").and_then(Value::as_str)
            == Some(activation.manifest_id.as_str())
        && receipt_json.get("schema").and_then(Value::as_str)
            == Some("butler.agent-btcc-storage-migration.v1")
        && marker_json.get("manifestId").and_then(Value::as_str)
            == Some(activation.manifest_id.as_str())
        && marker_json.get("schema").and_then(Value::as_str)
            == Some("butler.agent-btcc-storage-activation.v1")
        && marker_json.get("storageContract").and_then(Value::as_str) == Some("split-v1")
        && marker_json
            .get("firstActivatedAt")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty())
        && marker_json
            .get("activatedAt")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty());
    if !valid {
        return Err(StorageError::new(
            StorageCode::AgentBtccStorageActivationInvalid,
            "BTCC split activation does not match its validated migration receipt",
        ));
    }
    Ok(())
}

fn storage_marker(
    connection: &Connection,
    table: &str,
    json_column: &str,
) -> StorageResult<Option<(String, String)>> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .is_some();
    if !exists {
        return Ok(None);
    }
    connection
        .query_row(
            &format!("SELECT manifest_id, {json_column} FROM {table} WHERE singleton = 1"),
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)
}

fn parse_marker(value: &str, code: StorageCode) -> StorageResult<Value> {
    serde_json::from_str(value)
        .map_err(|error| StorageError::new(code, error.to_string()).with_source(error))
}
