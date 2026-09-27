use rusqlite::Connection;

use crate::workspace::{WorkspaceError, WorkspaceResult};

pub(in crate::workspace) fn ensure(connection: &Connection) -> WorkspaceResult<()> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS session_bindings (
                session_id TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                lifecycle_state TEXT NOT NULL,
                project_id TEXT,
                app_project_id TEXT,
                ledger_project_id TEXT,
                workspace_path TEXT NOT NULL,
                runtime_adapter_id TEXT NOT NULL,
                model_provider_id TEXT NOT NULL,
                model_ref TEXT NOT NULL,
                runtime_session_ref TEXT,
                provider_thread_ref TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_active_at TEXT,
                metadata_json TEXT
            );
            CREATE TABLE IF NOT EXISTS session_transport_bindings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES session_bindings(session_id) ON DELETE CASCADE,
                transport TEXT NOT NULL,
                account_id TEXT NOT NULL,
                peer_id TEXT NOT NULL,
                thread_id TEXT NOT NULL DEFAULT ''
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_session_transport_unique
                ON session_transport_bindings
                (session_id, transport, account_id, peer_id, thread_id);
            CREATE INDEX IF NOT EXISTS idx_session_transport_lookup
                ON session_transport_bindings (transport, account_id, peer_id, thread_id);
            CREATE INDEX IF NOT EXISTS idx_session_lifecycle_state
                ON session_bindings (lifecycle_state, updated_at);",
        )
        .map_err(WorkspaceError::sqlite)?;
    ensure_column(connection, "app_project_id", "TEXT")?;
    ensure_column(connection, "ledger_project_id", "TEXT")?;
    connection
        .execute(
            "UPDATE session_bindings SET app_project_id = project_id
             WHERE app_project_id IS NULL AND project_id IS NOT NULL",
            [],
        )
        .map_err(WorkspaceError::sqlite)?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    column: &'static str,
    definition: &'static str,
) -> WorkspaceResult<()> {
    let mut statement = connection
        .prepare("PRAGMA table_info(session_bindings)")
        .map_err(WorkspaceError::sqlite)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(WorkspaceError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(WorkspaceError::sqlite)?;
    if !columns.iter().any(|value| value == column) {
        connection
            .execute_batch(&format!(
                "ALTER TABLE session_bindings ADD COLUMN {column} {definition}"
            ))
            .map_err(WorkspaceError::sqlite)?;
    }
    Ok(())
}
