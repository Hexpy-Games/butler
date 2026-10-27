//! Preserve existing schedules' browser capability once, after legacy import.
use super::super::AppStorageError;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

const MARKER: &str = "schedule_browser_options_v1";

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
        "UPDATE app_automations AS a SET browser_signin=(
          EXISTS(SELECT 1 FROM browser_site_access WHERE all_conversations=1)
          OR EXISTS(SELECT 1 FROM browser_site_grants WHERE session_id=a.target_session_id)
          OR EXISTS(SELECT 1 FROM app_automation_grant_sources s
            JOIN browser_site_grants g ON g.session_id=s.source_session_id
            WHERE s.automation_id=a.id)),
        browser_payment=EXISTS(SELECT 1 FROM browser_vault_sites s
          JOIN browser_purchase_sites p ON p.site=s.site
          JOIN browser_payment_cards c ON c.id=s.item_id WHERE s.kind='card')
        WHERE a.state!='deleted';",
    )
    .map_err(AppStorageError::sqlite)?;
    tx.execute(
        "INSERT INTO app_settings(key,value_json,updated_at) VALUES(?1,'true',datetime('now'))",
        [MARKER],
    )
    .map_err(AppStorageError::sqlite)?;
    tx.commit().map_err(AppStorageError::sqlite)
}
