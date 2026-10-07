//! Existing App schema migration in its source-defined order.

mod core;
mod migration;
mod monitoring;
mod project_ledger_bindings;
mod schedule_access;
mod schedule_legacy;
mod security;
mod space;
mod supporting;
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
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS chats_archived_idx ON chats(archived);
         CREATE INDEX IF NOT EXISTS projects_archived_idx ON projects(archived);
         CREATE UNIQUE INDEX IF NOT EXISTS chats_runtime_hint_idx
           ON chats(runtime_session_hint) WHERE runtime_session_hint IS NOT NULL;
         CREATE INDEX IF NOT EXISTS chats_conversation_idx
           ON chats(conversation_session_id) WHERE conversation_session_id IS NOT NULL;
         CREATE INDEX IF NOT EXISTS projected_transport_chat_idx ON projected_transport_events(chat_id);
         CREATE INDEX IF NOT EXISTS projection_receipts_chat_idx ON app_transport_projection_receipts(chat_id);
         CREATE INDEX IF NOT EXISTS staged_outbounds_chat_idx ON app_transport_projection_staged_outbounds(chat_id);
         CREATE INDEX IF NOT EXISTS terminal_projection_chat_idx ON app_terminal_turn_projections(chat_id);
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
    schedule_access::backfill(connection)?;
    migration::create_post_backfill_indexes(connection)?;
    run_backfills_once(connection)?;
    migration::settle_ended_turn_messages(connection)?;
    project_ledger_bindings::initialize(connection, butler_data)?;
    space::migrate(connection)?;
    wallpapers::create(connection)?;
    monitoring::migrate(connection)?;
    Ok(())
}

/// `PRAGMA user_version` once the full-table backfills of an older database
/// have run. Both leave a current database untouched, but finding that out
/// reads every message.
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
    schedule_legacy::migrate(connection, butler_data)
}

#[cfg(test)]
mod plans;
#[cfg(test)]
mod tests;
