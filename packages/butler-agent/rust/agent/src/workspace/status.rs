use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use super::{WorkspaceError, WorkspaceResult};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StatusSessionIdentity {
    pub(crate) session_id: String,
    pub(crate) model_ref: String,
}

pub(crate) fn read_active_butler_session(
    path: &Path,
) -> WorkspaceResult<Option<StatusSessionIdentity>> {
    match std::fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(WorkspaceError::new(
                "session_store_unavailable",
                error.to_string(),
            ));
        }
        Ok(_) => {}
    }

    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| WorkspaceError::new("session_store_unavailable", error.to_string()))?;
    connection
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(|error| WorkspaceError::new("session_store_unavailable", error.to_string()))?;
    connection
        .pragma_update(None, "query_only", "ON")
        .map_err(|error| WorkspaceError::new("session_store_unavailable", error.to_string()))?;

    let has_bindings: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_bindings')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| WorkspaceError::new("session_store_schema_unavailable", error.to_string()))?;
    if !has_bindings {
        return Err(WorkspaceError::new(
            "session_store_schema_unavailable",
            "session_bindings table is missing",
        ));
    }

    let session = connection
        .query_row(
            "SELECT session_id, model_ref FROM session_bindings \
             WHERE role='butler' AND lifecycle_state IN ('active','closing') \
             ORDER BY updated_at DESC, session_id ASC LIMIT 1",
            [],
            |row| {
                Ok(StatusSessionIdentity {
                    session_id: row.get(0)?,
                    model_ref: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(|error| {
            WorkspaceError::new("session_store_schema_unavailable", error.to_string())
        })?;
    connection.close().map_err(|(_, error)| {
        WorkspaceError::new("session_store_close_failed", error.to_string())
    })?;
    Ok(session)
}
