//! Personal ordering only; shared canon entities live in BTCC.
use super::super::AppStorageError;
use rusqlite::Connection;

pub(super) fn create(connection: &Connection) -> Result<(), AppStorageError> {
    let tx = connection
        .unchecked_transaction()
        .map_err(AppStorageError::sqlite)?;
    create_tables(&tx)?;
    tx.commit().map_err(AppStorageError::sqlite)
}
fn create_tables(connection: &Connection) -> Result<(), AppStorageError> {
    let old: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('app_canon_conversations') WHERE name='work_id')",
        [], |r| r.get(0),
    ).map_err(AppStorageError::sqlite)?;
    if old {
        connection.execute_batch("ALTER TABLE app_canon_conversations RENAME TO app_canon_conversations_old;
            CREATE TABLE app_canon_conversations (
                session_id TEXT NOT NULL, epic_id TEXT NOT NULL, project_id TEXT NOT NULL,
                op_id TEXT NOT NULL UNIQUE, PRIMARY KEY(session_id,epic_id));
            INSERT INTO app_canon_conversations SELECT session_id,work_id,project_id,op_id FROM app_canon_conversations_old;
            DROP TABLE app_canon_conversations_old;").map_err(AppStorageError::sqlite)?;
    }
    let has_home: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('app_canon_conversations') WHERE name='is_home')",
        [], |r| r.get(0),
    ).map_err(AppStorageError::sqlite)?;
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='app_canon_conversations')",
            [],
            |r| r.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    if exists && !has_home {
        connection.execute_batch("ALTER TABLE app_canon_conversations ADD COLUMN is_home INTEGER NOT NULL DEFAULT 0 CHECK(is_home IN (0,1));
            UPDATE app_canon_conversations SET is_home=1")
            .map_err(AppStorageError::sqlite)?;
    }
    let reserved: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='app_canon_proposal_projects')",
            [],
            |r| r.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    if reserved {
        let created: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('app_canon_proposal_projects') WHERE name='workspace_created')", [], |r| r.get(0)).map_err(AppStorageError::sqlite)?;
        if !created {
            connection.execute_batch("ALTER TABLE app_canon_proposal_projects ADD COLUMN workspace_created INTEGER NOT NULL DEFAULT 0 CHECK(workspace_created IN (0,1))").map_err(AppStorageError::sqlite)?;
        }
    }
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS app_canon_proposal_projects (
            proposal_id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, workspace TEXT NOT NULL, created_at TEXT NOT NULL, resolved_by TEXT, workspace_created INTEGER NOT NULL DEFAULT 0 CHECK(workspace_created IN (0,1))
         );
         CREATE INDEX IF NOT EXISTS projects_recent_canon ON projects(archived,updated_at DESC);
         CREATE TABLE IF NOT EXISTS app_canon_conversations (
            session_id TEXT NOT NULL,
            epic_id TEXT NOT NULL,
            is_home INTEGER NOT NULL DEFAULT 0 CHECK(is_home IN (0,1)),
            project_id TEXT NOT NULL,
            op_id TEXT NOT NULL UNIQUE,
            PRIMARY KEY(session_id,epic_id)
         );
         CREATE INDEX IF NOT EXISTS app_canon_conversations_epic ON app_canon_conversations(epic_id);
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
         CREATE INDEX IF NOT EXISTS app_canon_sidebar_order_work ON app_canon_sidebar_order(work_id);
         CREATE UNIQUE INDEX IF NOT EXISTS app_canon_sidebar_order_op
         ON app_canon_sidebar_order(op_id) WHERE op_id IS NOT NULL;",
        )
        .map_err(AppStorageError::sqlite)
}

#[cfg(test)]
pub(super) const ORDERED_READ: &str = "SELECT work_id,position FROM app_canon_sidebar_order
 WHERE project_id=?1 AND group_key=?2 ORDER BY position";
