use rusqlite::Connection;

use super::contracts::{AppSpaceGroup, AppSpaceNode, AppSpaceView};
use crate::gateway::application::storage::AppStorageError;

pub(in crate::gateway::application) fn read(
    db: &Connection,
) -> Result<AppSpaceView, AppStorageError> {
    let revision = db
        .query_row(
            "SELECT revision FROM app_space_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    let mut statement = db
        .prepare(
            "SELECT n.node_key,
                CASE WHEN n.session_id IS NOT NULL THEN 'session'
                     WHEN n.project_id IS NOT NULL THEN 'project' ELSE 'group' END,
                COALESCE(n.session_id,n.project_id,n.group_id),n.parent_key,n.position,
                n.revision,n.manual_placement,
                CASE WHEN n.session_id IS NOT NULL THEN c.project_id
                     WHEN n.group_id IS NOT NULL THEN g.scope_project_id ELSE NULL END
             FROM app_space_nodes n
             LEFT JOIN chats c ON c.id=n.session_id
             LEFT JOIN app_space_groups g ON g.id=n.group_id
             ORDER BY n.position,n.node_key",
        )
        .map_err(AppStorageError::sqlite)?;
    let nodes = statement
        .query_map([], |row| {
            Ok(AppSpaceNode {
                key: row.get(0)?,
                kind: row.get(1)?,
                entity_id: row.get(2)?,
                parent_key: row.get(3)?,
                position: row.get(4)?,
                revision: row.get(5)?,
                manual_placement: row.get::<_, i64>(6)? != 0,
                scope_project_id: row.get(7)?,
            })
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let mut statement = db
        .prepare("SELECT id,title,scope_project_id,origin FROM app_space_groups ORDER BY id")
        .map_err(AppStorageError::sqlite)?;
    let groups = statement
        .query_map([], |row| {
            Ok(AppSpaceGroup {
                id: row.get(0)?,
                title: row.get(1)?,
                scope_project_id: row.get(2)?,
                origin: row.get(3)?,
            })
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    Ok(AppSpaceView {
        smart_notice: None,
        revision,
        nodes,
        groups,
    })
}
