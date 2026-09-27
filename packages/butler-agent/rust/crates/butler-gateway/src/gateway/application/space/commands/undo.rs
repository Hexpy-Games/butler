use rusqlite::{Connection, params};

use super::super::contracts::AppSpaceView;
use super::super::tree;
use super::super::{commands::SpaceHistory, commands::Undo};
use super::tree_mutations;
use crate::gateway::GatewayApplicationError;
use crate::gateway::application::{AppIdentityClock, storage::AppStorageError};

pub(super) fn restore(
    db: &Connection,
    history: &mut SpaceHistory,
    token: &str,
    revision: i64,
    clock: &dyn AppIdentityClock,
) -> Result<(), GatewayApplicationError> {
    let undo = history.undo.clone();
    let Some(undo) = undo.filter(|undo| undo.token == token && undo.revision == revision) else {
        return Err(tree::error(
            "space_undo_expired",
            "다른 변경이 있어 되돌릴 수 없습니다.",
        ));
    };
    let now = clock.now_iso();
    for group in &undo.groups {
        db.execute(
            "INSERT INTO app_space_groups VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at",
            params![group.id, group.title, group.scope_project_id, group.origin, now, now],
        )
        .map_err(storage_error)?;
    }
    for node in undo.nodes.iter().filter(|node| node.kind == "group") {
        db.execute(
            "INSERT OR IGNORE INTO app_space_nodes(node_key,group_id,parent_key,position) VALUES(?,?,NULL,?)",
            params![node.key, node.entity_id, node.position],
        )
        .map_err(storage_error)?;
    }
    let restored = undo
        .nodes
        .iter()
        .cloned()
        .map(|mut node| {
            node.manual_placement = true;
            node
        })
        .collect::<Vec<_>>();
    tree_mutations::save_nodes(db, &restored)?;
    for key in &undo.remove_nodes {
        db.execute("DELETE FROM app_space_nodes WHERE node_key=?", [key])
            .map_err(storage_error)?;
    }
    for id in &undo.remove_groups {
        db.execute("DELETE FROM app_space_groups WHERE id=?", [id])
            .map_err(storage_error)?;
    }
    history.undo = None;
    history.smart_notice = None;
    Ok(())
}

pub(super) fn inverse_change(before: &AppSpaceView, after: &AppSpaceView, token: String) -> Undo {
    let next_nodes = after
        .nodes
        .iter()
        .map(|node| (node.key.as_str(), node))
        .collect::<std::collections::HashMap<_, _>>();
    let next_groups = after
        .groups
        .iter()
        .map(|group| (group.id.as_str(), group))
        .collect::<std::collections::HashMap<_, _>>();
    let old_nodes = before
        .nodes
        .iter()
        .map(|node| node.key.as_str())
        .collect::<std::collections::HashSet<_>>();
    let old_groups = before
        .groups
        .iter()
        .map(|group| group.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    Undo {
        token,
        revision: after.revision,
        nodes: before
            .nodes
            .iter()
            .filter(|node| next_nodes.get(node.key.as_str()).copied() != Some(*node))
            .cloned()
            .collect(),
        groups: before
            .groups
            .iter()
            .filter(|group| next_groups.get(group.id.as_str()).copied() != Some(*group))
            .cloned()
            .collect(),
        remove_nodes: after
            .nodes
            .iter()
            .filter(|node| !old_nodes.contains(node.key.as_str()))
            .map(|node| node.key.clone())
            .collect(),
        remove_groups: after
            .groups
            .iter()
            .filter(|group| !old_groups.contains(group.id.as_str()))
            .map(|group| group.id.clone())
            .collect(),
    }
}

fn storage_error(error: rusqlite::Error) -> GatewayApplicationError {
    super::super::super::app_error(AppStorageError::sqlite(error))
}
