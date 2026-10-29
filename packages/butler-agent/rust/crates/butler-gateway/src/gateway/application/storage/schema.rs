//! Existing App schema migration in its source-defined order.

mod asset_versions;
mod assets;
pub(in crate::gateway::application) mod canon;
pub(in crate::gateway::application) mod canon_files;
mod canon_sidebar;
mod connectors;
mod core;
mod documents;
mod initiated;
mod library;
mod message_ownership;
mod migration;
mod monitoring;
pub(super) mod pending_asks;
mod project_ledger_bindings;
mod schedule_access;
mod schedule_browser;
mod schedule_legacy;
mod security;
mod session_reads;
mod signins;
mod space;
mod still_delivery;
mod supporting;
mod vault;
mod wallpapers;

use std::path::Path;

use rusqlite::Connection;

use super::AppStorageError;
use crate::gateway::application::settings::{
    record_default_access_mode, record_default_model_policy,
};

pub(super) fn migrate(
    connection: &mut Connection,
    butler_data: Option<&Path>,
) -> Result<(), AppStorageError> {
    let turns_new = !migration::table_exists(connection, "turns")?;
    core::create(connection)?;
    ensure_message_file_columns(connection)?;
    library::create(connection)?;
    canon_sidebar::create(connection)?;
    canon::create(connection)?;
    canon_files::create(connection)?;
    still_delivery::recover(connection)?;
    super::history::schema::create(connection)?;
    security::create(connection)?;
    // Open-turn lookups filter on the state alone; databases that predate the
    // index get it here.
    connection
        .execute_batch("CREATE INDEX IF NOT EXISTS turns_state_rowid_idx ON turns(state)")
        .map_err(AppStorageError::sqlite)?;
    supporting::create(connection)?;
    // An App database from before ask-first (#236) keeps full access until
    // the user saves a mode; a new one asks first. Before the schedule
    // backfill, which resolves unsaved modes with it.
    record_default_access_mode(connection, !turns_new)?;
    // Likewise its default model (#230): the legacy default for an existing
    // database, the connected provider's routine preset for a new one.
    record_default_model_policy(connection, !turns_new)?;
    migration::add_current_columns(connection)?;
    initiated::create(connection)?;
    assets::create(connection)?;
    super::super::image_usage::create(connection)?;
    documents::create(connection)?;
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS chats_archived_idx ON chats(archived);
         CREATE INDEX IF NOT EXISTS projects_canon_name ON projects(display_name,id) WHERE archived=0;
         CREATE INDEX IF NOT EXISTS projects_archived_idx ON projects(archived);
         CREATE UNIQUE INDEX IF NOT EXISTS chats_runtime_hint_idx
           ON chats(runtime_session_hint) WHERE runtime_session_hint IS NOT NULL;
         DROP INDEX IF EXISTS initiated_retry_chat_idx;
         DROP INDEX IF EXISTS chats_conversation_idx;
         DROP INDEX IF EXISTS projected_transport_chat_idx;
         DROP INDEX IF EXISTS projection_receipts_chat_idx;
         DROP INDEX IF EXISTS staged_outbounds_chat_idx;
         DROP INDEX IF EXISTS terminal_projection_chat_idx;
         CREATE TABLE IF NOT EXISTS app_output_transfers(archive_id TEXT PRIMARY KEY);
         CREATE TABLE IF NOT EXISTS app_session_delete_cleanups(
           session_id TEXT PRIMARY KEY,session_hint TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS automation_runs_target_idx ON app_automation_runs(target_session_id)",
    ).map_err(AppStorageError::sqlite)?;
    // Existing App databases also need the actual-column index. Historical
    // payload turn ids can differ from events.turn_id, so the JSON indexes do
    // not serve retention's authoritative turn lookup.
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS events_turn_id_idx \
             ON events(turn_id,id DESC) WHERE turn_id<>''; \
             CREATE INDEX IF NOT EXISTS projects_ledger_id_idx ON projects(ledger_project_id); \
             CREATE INDEX IF NOT EXISTS idx_chats_authority_metadata ON chats(id,title,project_id); \
             CREATE INDEX IF NOT EXISTS idx_projects_authority_metadata ON projects(id,display_name)",
        )
        .map_err(AppStorageError::sqlite)?;
    migration::backfill_queue_identity(connection)?;
    create_queue_order_index(connection)?;
    schedule_access::backfill(connection)?;
    migration::create_post_backfill_indexes(connection)?;
    run_backfills_once(connection)?;
    migration::settle_ended_turn_messages(connection)?;
    migrate_app_features(connection, butler_data)?;
    Ok(())
}

fn ensure_message_file_columns(connection: &Connection) -> Result<(), AppStorageError> {
    migration::ensure_column(connection, "message_files", "title", "TEXT")?;
    migration::ensure_column(connection, "message_files", "source_label", "TEXT")?;
    migration::ensure_column(
        connection,
        "message_files",
        "deliverable",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    migration::ensure_column(connection, "message_files", "width", "INTEGER")?;
    migration::ensure_column(connection, "message_files", "height", "INTEGER")?;
    Ok(())
}

/// Added after legacy queue columns have been backfilled.
fn create_queue_order_index(connection: &Connection) -> Result<(), AppStorageError> {
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS session_queued_messages_result_order_idx
         ON session_queued_messages(chat_id,state,
           (CASE WHEN json_valid(control_resolution_json)
                 THEN json_type(control_resolution_json,'$.subsession_result') IS 'object' ELSE 0 END) DESC)"
    ).map_err(AppStorageError::sqlite)
}

/// `PRAGMA user_version` once the full-table backfills of an older database
/// have run. Finding rows that need these backfills reads every message.
const BACKFILLS_DONE: i64 = 1;

fn run_backfills_once(connection: &Connection) -> Result<(), AppStorageError> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(AppStorageError::sqlite)?;
    if version >= BACKFILLS_DONE {
        return Ok(());
    }
    supporting::backfill_search_index(connection)?;
    migration::backfill_message_updated_at(connection)?;
    connection
        .pragma_update(None, "user_version", BACKFILLS_DONE)
        .map_err(AppStorageError::sqlite)
}

pub(super) fn seed(connection: &Connection, now: &str) -> Result<(), AppStorageError> {
    connection.execute(
        "INSERT OR IGNORE INTO chats(id,title,kind,project_id,pinned,archived,created_at,updated_at) \
         VALUES('general','General','chat',NULL,0,0,?1,?1)",
        [now],
    ).map_err(AppStorageError::sqlite)?;
    connection
        .execute(
            "UPDATE chats SET archived=0 WHERE id='general' AND archived!=0",
            [],
        )
        .map_err(AppStorageError::sqlite)?;
    connection
        .execute(
            "UPDATE chats SET title='General',updated_at=?1 WHERE id='general' \
         AND title IN ('Onboarding','onboarding','New chat')",
            [now],
        )
        .map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(super) fn migrate_legacy_schedules(
    connection: &mut Connection,
    butler_data: Option<&Path>,
) -> Result<(), AppStorageError> {
    schedule_legacy::migrate(connection, butler_data)?;
    schedule_browser::migrate(connection)
}

#[cfg(test)]
mod plans;
#[cfg(test)]
mod tests;

pub(in crate::gateway::application) use core::create_settings_table;

fn migrate_app_features(
    connection: &mut Connection,
    butler_data: Option<&Path>,
) -> Result<(), AppStorageError> {
    project_ledger_bindings::initialize(connection, butler_data)?;
    space::migrate(connection)?;
    wallpapers::create(connection)?;
    signins::create(connection)?;
    vault::create(connection)?;
    message_ownership::migrate(connection)?;
    session_reads::create(connection)?;
    monitoring::migrate(connection)?;
    pending_asks::create(connection)?;
    connectors::create(connection)?;
    library::recover(connection, butler_data)?;
    Ok(())
}
