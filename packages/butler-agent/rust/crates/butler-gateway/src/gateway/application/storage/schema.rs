//! Existing App schema migration in its source-defined order.

mod core;
mod migration;
mod project_ledger_bindings;
mod schedule_access;
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
    if turns_new {
        connection
            .execute_batch("CREATE INDEX turns_state_rowid_idx ON turns(state)")
            .map_err(AppStorageError::sqlite)?;
    }
    supporting::create(connection)?;
    // An App database from before ask-first (#236) keeps full access until
    // the user saves a mode; a new one asks first. Before the schedule
    // backfill, which resolves unsaved modes with it.
    record_default_access_mode(connection, !turns_new)?;
    // Likewise its default model (#230): the legacy default for an existing
    // database, the connected provider's routine preset for a new one.
    record_default_model_policy(connection, !turns_new)?;
    migration::add_current_columns(connection)?;
    // Existing App databases also need the actual-column index. Historical
    // payload turn ids can differ from events.turn_id, so the JSON indexes do
    // not serve retention's authoritative turn lookup.
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS events_turn_id_idx \
             ON events(turn_id,id DESC) WHERE turn_id<>''",
        )
        .map_err(AppStorageError::sqlite)?;
    migration::backfill_queue_identity(connection)?;
    schedule_access::backfill(connection)?;
    migration::create_post_backfill_indexes(connection)?;
    project_ledger_bindings::initialize(connection, butler_data)?;
    space::migrate(connection)?;
    wallpapers::create(connection)?;
    Ok(())
}

pub(super) fn seed(connection: &Connection, now: &str) -> Result<(), AppStorageError> {
    connection.execute(
        "INSERT OR IGNORE INTO chats(id,title,kind,project_id,pinned,archived,created_at,updated_at) \
         VALUES('general','Onboarding','chat',NULL,0,0,?1,?1)",
        [now],
    ).map_err(AppStorageError::sqlite)?;
    connection
        .execute(
            "UPDATE chats SET archived=0 WHERE id='general' AND archived!=0",
            [],
        )
        .map_err(AppStorageError::sqlite)?;
    connection.execute(
        "UPDATE chats SET title='Onboarding',updated_at=?1 WHERE id='general' AND title='New chat' \
         AND NOT EXISTS(SELECT 1 FROM messages WHERE messages.chat_id=chats.id)", [now],
    ).map_err(AppStorageError::sqlite)?;
    Ok(())
}

#[cfg(test)]
mod tests;
