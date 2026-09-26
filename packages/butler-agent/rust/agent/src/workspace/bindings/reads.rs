use rusqlite::{Connection, Row, params_from_iter};

use super::{
    SESSION_COLUMNS, SessionLifecycleState, SessionRole, SessionTransportBinding,
    StoredSessionBinding, parse_metadata,
};
use crate::workspace::{SessionBindingStore, WorkspaceError, WorkspaceResult};

struct SessionRow {
    session_id: String,
    role: String,
    lifecycle_state: String,
    project_id: Option<String>,
    app_project_id: Option<String>,
    ledger_project_id: Option<String>,
    workspace_path: String,
    runtime_adapter_id: String,
    model_provider_id: String,
    model_ref: String,
    runtime_session_ref: Option<String>,
    provider_thread_ref: Option<String>,
    created_at: String,
    updated_at: String,
    last_active_at: Option<String>,
    metadata_json: Option<String>,
}

impl SessionBindingStore {
    pub(crate) async fn get_by_session_id(
        &self,
        session_id: &str,
    ) -> WorkspaceResult<Option<StoredSessionBinding>> {
        let session_id = session_id.to_owned();
        self.execute(move |connection| get_by_session_id(connection, &session_id))
            .await
    }

    pub(crate) async fn list_sessions(
        &self,
        lifecycle_states: Option<Vec<SessionLifecycleState>>,
    ) -> WorkspaceResult<Vec<StoredSessionBinding>> {
        self.execute(move |connection| {
            let states = lifecycle_states.unwrap_or_default();
            let filter = if states.is_empty() {
                String::new()
            } else {
                format!(
                    " WHERE lifecycle_state IN ({})",
                    vec!["?"; states.len()].join(", ")
                )
            };
            let sql = format!(
                "SELECT {SESSION_COLUMNS} FROM session_bindings{filter}
                 ORDER BY updated_at DESC, session_id ASC"
            );
            let values = states.iter().map(SessionLifecycleState::as_str);
            let mut statement = connection.prepare(&sql).map_err(WorkspaceError::sqlite)?;
            let rows = statement
                .query_map(params_from_iter(values), read_row)
                .map_err(WorkspaceError::sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(WorkspaceError::sqlite)?;
            rows.into_iter()
                .map(|row| hydrate(connection, row))
                .collect()
        })
        .await
    }
}

pub(super) fn get_by_session_id(
    connection: &Connection,
    session_id: &str,
) -> WorkspaceResult<Option<StoredSessionBinding>> {
    let sql =
        format!("SELECT {SESSION_COLUMNS} FROM session_bindings WHERE session_id = ? LIMIT 1");
    let mut statement = connection.prepare(&sql).map_err(WorkspaceError::sqlite)?;
    let mut rows = statement
        .query_map([session_id], read_row)
        .map_err(WorkspaceError::sqlite)?;
    let row = rows.next().transpose().map_err(WorkspaceError::sqlite)?;
    row.map(|row| hydrate(connection, row)).transpose()
}

fn read_row(row: &Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        session_id: row.get(0)?,
        role: row.get(1)?,
        lifecycle_state: row.get(2)?,
        project_id: row.get(3)?,
        app_project_id: row.get(4)?,
        ledger_project_id: row.get(5)?,
        workspace_path: row.get(6)?,
        runtime_adapter_id: row.get(7)?,
        model_provider_id: row.get(8)?,
        model_ref: row.get(9)?,
        runtime_session_ref: row.get(10)?,
        provider_thread_ref: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        last_active_at: row.get(14)?,
        metadata_json: row.get(15)?,
    })
}

fn hydrate(connection: &Connection, row: SessionRow) -> WorkspaceResult<StoredSessionBinding> {
    let app_project_id = row.app_project_id.or_else(|| row.project_id.clone());
    Ok(StoredSessionBinding {
        session_id: row.session_id.clone(),
        role: SessionRole::parse(&row.role),
        lifecycle_state: SessionLifecycleState::parse(&row.lifecycle_state),
        project_id: row.project_id,
        app_project_id,
        ledger_project_id: row.ledger_project_id,
        workspace_path: row.workspace_path,
        runtime_adapter_id: row.runtime_adapter_id,
        model_provider_id: row.model_provider_id,
        model_ref: row.model_ref,
        runtime_session_ref: row.runtime_session_ref,
        provider_thread_ref: row.provider_thread_ref,
        transport_bindings: transport_bindings(connection, &row.session_id)?,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_active_at: row.last_active_at,
        metadata: parse_metadata(row.metadata_json.as_ref()),
    })
}

fn transport_bindings(
    connection: &Connection,
    session_id: &str,
) -> WorkspaceResult<Vec<SessionTransportBinding>> {
    let mut statement = connection
        .prepare(
            "SELECT transport, account_id, peer_id, thread_id
             FROM session_transport_bindings WHERE session_id = ?
             ORDER BY transport ASC, account_id ASC, peer_id ASC, thread_id ASC",
        )
        .map_err(WorkspaceError::sqlite)?;
    statement
        .query_map([session_id], |row| {
            let thread_id = row.get::<_, String>(3)?;
            Ok(SessionTransportBinding {
                transport: row.get(0)?,
                account_id: row.get(1)?,
                peer_id: row.get(2)?,
                thread_id: (!thread_id.is_empty()).then_some(thread_id),
            })
        })
        .map_err(WorkspaceError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(WorkspaceError::sqlite)
}
