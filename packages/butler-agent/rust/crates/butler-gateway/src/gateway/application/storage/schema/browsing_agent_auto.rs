//! Enable browsing once for stored settings from before the auto default.
use super::super::AppStorageError;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

const MARKER: &str = "browsing_agent_auto_v1";

pub(super) fn migrate(db: &mut Connection) -> Result<(), AppStorageError> {
    let done = db
        .query_row("SELECT 1 FROM app_settings WHERE key=?1", [MARKER], |_| {
            Ok(())
        })
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if done.is_some() {
        return Ok(());
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(AppStorageError::sqlite)?;
    tx.execute_batch(
        "UPDATE app_settings SET value_json = json_set(value_json, '$.browser.browsing_agent', 'auto')
         WHERE key = 'settings' AND json_extract(value_json, '$.browser.browsing_agent') = 'off';",
    )
    .map_err(AppStorageError::sqlite)?;
    tx.execute(
        "INSERT INTO app_settings(key,value_json,updated_at) VALUES(?1,'true',datetime('now'))",
        [MARKER],
    )
    .map_err(AppStorageError::sqlite)?;
    tx.commit().map_err(AppStorageError::sqlite)
}
