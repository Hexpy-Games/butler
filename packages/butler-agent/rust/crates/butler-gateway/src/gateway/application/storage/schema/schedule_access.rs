//! Schedules (#237) carry their own access mode. A schedule stored before
//! that ran with its target conversation's mode, so the migration copies the
//! mode the conversation has now, resolving an unset one to the default of
//! that time (full access), and the schedule keeps behaving as it did.

use rusqlite::{Connection, params};

use super::super::AppStorageError;
use crate::gateway::application::settings::{
    PRE_ASK_FIRST_ACCESS_MODE, access_mode_name, stored_session_access,
};

/// Fills `access_mode` of every schedule stored without one.
pub(super) fn backfill(connection: &Connection) -> Result<(), AppStorageError> {
    let mut statement = connection
        .prepare("SELECT id,target_session_id FROM app_automations WHERE access_mode IS NULL")
        .map_err(AppStorageError::sqlite)?;
    let schedules = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    drop(statement);
    for (id, target) in schedules {
        let mode = stored_session_access(connection, &target, PRE_ASK_FIRST_ACCESS_MODE)?;
        connection
            .execute(
                "UPDATE app_automations SET access_mode=?1 WHERE id=?2 AND access_mode IS NULL",
                params![access_mode_name(&mode), id],
            )
            .map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}
