use std::time::Duration;

use rusqlite::{Connection, ErrorCode};
use tokio_util::sync::CancellationToken;

use super::{BtccStorage, StorageError, StorageResult};
use crate::btcc::BtccCode;
use crate::btcc::BtccError;

const PROBE_TIMEOUT: Duration = Duration::from_millis(250);
const OWNER_TIMEOUT: Duration = Duration::from_millis(5_000);

pub(super) async fn wait(
    storage: &BtccStorage,
    cancellation: CancellationToken,
) -> Result<(), BtccError> {
    loop {
        cancelled(&cancellation)?;
        let writable = storage.execute(probe).await.map_err(BtccError::from)?;
        cancelled(&cancellation)?;
        if writable {
            return Ok(());
        }
        tokio::task::yield_now().await;
    }
}

fn probe(connection: &mut Connection) -> StorageResult<bool> {
    connection
        .busy_timeout(PROBE_TIMEOUT)
        .map_err(StorageError::sqlite)?;
    let attempt = begin_and_rollback(connection);
    let restored = connection
        .busy_timeout(OWNER_TIMEOUT)
        .map_err(StorageError::sqlite);
    match (attempt, restored) {
        (Ok(writable), Ok(())) => Ok(writable),
        (Err(error), Ok(())) | (_, Err(error)) => Err(error),
    }
}

fn begin_and_rollback(connection: &mut Connection) -> StorageResult<bool> {
    match connection.execute_batch("BEGIN IMMEDIATE") {
        Ok(()) => {
            connection
                .execute_batch("ROLLBACK")
                .map_err(StorageError::sqlite)?;
            Ok(true)
        }
        Err(cause) if contention(&cause) => {
            if !connection.is_autocommit() {
                connection
                    .execute_batch("ROLLBACK")
                    .map_err(StorageError::sqlite)?;
            }
            Ok(false)
        }
        Err(cause) => {
            if !connection.is_autocommit() {
                let _ignored_rollback = connection.execute_batch("ROLLBACK");
            }
            Err(StorageError::sqlite(cause))
        }
    }
}

fn contention(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

fn cancelled(cancellation: &CancellationToken) -> Result<(), BtccError> {
    if cancellation.is_cancelled() {
        Err(BtccError::detected(
            BtccCode::Cancelled,
            "storage readiness cancelled",
        ))
    } else {
        Ok(())
    }
}
