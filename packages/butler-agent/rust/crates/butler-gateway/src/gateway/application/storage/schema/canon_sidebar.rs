//! Personal ordering only; shared canon entities live in BTCC.
use super::super::AppStorageError;
use rusqlite::Connection;

pub(super) fn create(connection: &Connection) -> Result<(), AppStorageError> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS app_canon_conversations (
            session_id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL UNIQUE,
            project_id TEXT NOT NULL,
            op_id TEXT NOT NULL UNIQUE
         );
         CREATE INDEX IF NOT EXISTS app_canon_conversations_project
         ON app_canon_conversations(project_id,session_id);
         CREATE TABLE IF NOT EXISTS app_canon_sidebar_order (
            project_id TEXT NOT NULL,
            group_key TEXT NOT NULL,
            work_id TEXT NOT NULL,
            position TEXT NOT NULL,
            op_id TEXT,
            PRIMARY KEY (project_id,group_key,work_id)
         );
         CREATE INDEX IF NOT EXISTS app_canon_sidebar_order_position
         ON app_canon_sidebar_order(project_id,group_key,position);
         CREATE UNIQUE INDEX IF NOT EXISTS app_canon_sidebar_order_op
         ON app_canon_sidebar_order(op_id) WHERE op_id IS NOT NULL;",
        )
        .map_err(AppStorageError::sqlite)
}

#[cfg(test)]
pub(super) const ORDERED_READ: &str = "SELECT work_id,position FROM app_canon_sidebar_order
 WHERE project_id=?1 AND group_key=?2 ORDER BY position";
