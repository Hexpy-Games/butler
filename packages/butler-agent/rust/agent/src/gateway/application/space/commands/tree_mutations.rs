use rusqlite::{Connection, params};

use super::super::contracts::{AppSpaceNode, AppSpaceOrigin, AppSpaceView};
use super::super::{reader, tree};
use crate::gateway::GatewayApplicationError;
use crate::gateway::application::{AppIdentityClock, storage::AppStorageError};

pub(super) fn create_group(
    db: &Connection,
    view: &AppSpaceView,
    raw_title: &str,
    parent_key: Option<&str>,
    origin: AppSpaceOrigin,
    clock: &dyn AppIdentityClock,
) -> Result<String, GatewayApplicationError> {
    let title = group_title(raw_title)?;
    let scope = tree::container_scope(view, parent_key)?;
    let id = clock.new_uuid();
    let now = clock.now_iso();
    db.execute(
        "INSERT INTO app_space_groups VALUES(?,?,?,?,?,?)",
        params![id, title, scope, origin.as_str(), now, now],
    )
    .map_err(storage_error)?;
    let siblings = tree::ordered_children(view, parent_key);
    db.execute(
        "INSERT INTO app_space_nodes(node_key,group_id,parent_key,position) VALUES(?,?,?,?)",
        params![
            format!("g:{id}"),
            id,
            parent_key,
            siblings.first().map_or(0, |node| node.position - 1)
        ],
    )
    .map_err(storage_error)?;
    Ok(id)
}

pub(super) fn rename_group(
    db: &Connection,
    view: &AppSpaceView,
    id: &str,
    raw_title: &str,
    clock: &dyn AppIdentityClock,
) -> Result<(), GatewayApplicationError> {
    tree::require_node(view, &format!("g:{id}"))?;
    db.execute(
        "UPDATE app_space_groups SET title=?,updated_at=? WHERE id=?",
        params![group_title(raw_title)?, clock.now_iso(), id],
    )
    .map_err(storage_error)?;
    Ok(())
}

pub(super) fn dissolve_group(
    db: &Connection,
    view: &AppSpaceView,
    id: &str,
) -> Result<(), GatewayApplicationError> {
    let group = tree::require_node(view, &format!("g:{id}"))?.clone();
    let mut siblings = tree::ordered_children(view, group.parent_key.as_deref());
    let children = tree::ordered_children(view, Some(group.key.as_str()))
        .into_iter()
        .map(|mut node| {
            node.parent_key = group.parent_key.clone();
            node.manual_placement = true;
            node
        })
        .collect::<Vec<_>>();
    let position = siblings
        .iter()
        .position(|node| node.key == group.key)
        .unwrap_or(siblings.len());
    siblings.splice(position..position.saturating_add(1), children);
    let siblings = siblings
        .into_iter()
        .enumerate()
        .map(|(position, mut node)| {
            node.position = position as i64;
            node
        })
        .collect::<Vec<_>>();
    save_nodes(db, &siblings)?;
    db.execute("DELETE FROM app_space_nodes WHERE node_key=?", [&group.key])
        .map_err(storage_error)?;
    db.execute("DELETE FROM app_space_groups WHERE id=?", [id])
        .map_err(storage_error)?;
    Ok(())
}

pub(super) fn group_sessions(
    db: &Connection,
    before: &AppSpaceView,
    source_key: &str,
    target_key: &str,
    title: &str,
    origin: AppSpaceOrigin,
    clock: &dyn AppIdentityClock,
) -> Result<String, GatewayApplicationError> {
    let source = tree::require_node(before, source_key)?.clone();
    let target = tree::require_node(before, target_key)?.clone();
    if source_key == target_key || source.kind != "session" || target.kind != "session" {
        return Err(tree::error(
            "space_invalid_group",
            "서로 다른 두 대화를 선택해 주세요.",
        ));
    }
    if source.scope_project_id != target.scope_project_id {
        return Err(tree::error(
            "space_project_boundary",
            "같은 프로젝트의 대화끼리 묶을 수 있습니다.",
        ));
    }
    let id = create_group(
        db,
        before,
        title,
        target.parent_key.as_deref(),
        origin,
        clock,
    )?;
    let group = reader::read(db)
        .map_err(super::app_error)?
        .nodes
        .into_iter()
        .find(|node| node.key == format!("g:{id}"))
        .ok_or(GatewayApplicationError::Internal)?;
    let mut siblings = tree::ordered_children(before, target.parent_key.as_deref())
        .into_iter()
        .filter(|node| node.key != source_key)
        .collect::<Vec<_>>();
    let index = siblings
        .iter()
        .position(|node| node.key == target_key)
        .unwrap_or(siblings.len());
    siblings.insert(index, group);
    let siblings = siblings
        .into_iter()
        .enumerate()
        .map(|(position, mut node)| {
            node.position = position as i64;
            node
        })
        .collect::<Vec<_>>();
    save_nodes(db, &siblings)?;
    let source_position = if origin == AppSpaceOrigin::Smart {
        1
    } else {
        0
    };
    let mut target_child = target;
    target_child.parent_key = Some(format!("g:{id}"));
    target_child.position = 1 - source_position;
    target_child.manual_placement = origin == AppSpaceOrigin::Manual;
    let mut source_child = source;
    source_child.parent_key = Some(format!("g:{id}"));
    source_child.position = source_position;
    source_child.manual_placement = origin == AppSpaceOrigin::Manual;
    save_nodes(db, &[target_child, source_child])?;
    Ok(id)
}

pub(super) fn pin(
    db: &Connection,
    view: &AppSpaceView,
    key: &str,
    pinned: bool,
) -> Result<(), GatewayApplicationError> {
    let node = tree::require_node(view, key)?;
    let table = match node.kind.as_str() {
        "session" => "chats",
        "project" => "projects",
        _ => {
            return Err(tree::error(
                "space_invalid_pin",
                "대화 또는 프로젝트를 즐겨찾기에 추가해 주세요.",
            ));
        }
    };
    db.execute(
        &format!("UPDATE {table} SET pinned=? WHERE id=?"),
        params![if pinned { 1_i64 } else { 0_i64 }, node.entity_id],
    )
    .map_err(storage_error)?;
    Ok(())
}

pub(in crate::gateway::application::space) fn save_nodes(
    db: &Connection,
    nodes: &[AppSpaceNode],
) -> Result<(), GatewayApplicationError> {
    for node in nodes {
        let manual = if node.manual_placement { 1_i64 } else { 0_i64 };
        db.execute(
            "UPDATE app_space_nodes SET parent_key=?,position=?,manual_placement=?,revision=revision+1 WHERE node_key=? AND (parent_key IS NOT ? OR position!=? OR manual_placement!=?)",
            params![node.parent_key,node.position,manual,node.key,node.parent_key,node.position,manual],
        )
        .map_err(storage_error)?;
    }
    Ok(())
}

fn group_title(value: &str) -> Result<String, GatewayApplicationError> {
    let title = value.trim();
    if title.is_empty() || title.encode_utf16().count() > 120 {
        return Err(tree::error(
            "space_invalid_title",
            "그룹 이름은 1~120자로 입력해 주세요.",
        ));
    }
    Ok(title.to_owned())
}

fn storage_error(error: rusqlite::Error) -> GatewayApplicationError {
    super::super::super::app_error(AppStorageError::sqlite(error))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Clock;
    impl AppIdentityClock for Clock {
        fn new_uuid(&self) -> String {
            "group-id".into()
        }
        fn now_iso(&self) -> String {
            "2026-09-25T00:00:00.000Z".into()
        }
        fn iso_after_millis(&self, _: u64) -> String {
            self.now_iso()
        }
    }

    #[test]
    fn named_group_is_inserted_before_existing_siblings() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE app_space_groups(id TEXT,title TEXT,scope_project_id TEXT,origin TEXT,created_at TEXT,updated_at TEXT);
             CREATE TABLE app_space_nodes(node_key TEXT,group_id TEXT,parent_key TEXT,position INTEGER);",
        ).unwrap();
        let view = AppSpaceView {
            smart_notice: None,
            revision: 1,
            nodes: vec![AppSpaceNode {
                key: "s:existing".into(),
                kind: "session".into(),
                entity_id: "existing".into(),
                parent_key: None,
                position: 0,
                revision: 1,
                manual_placement: false,
                scope_project_id: None,
            }],
            groups: vec![],
        };
        create_group(&db, &view, "검진", None, AppSpaceOrigin::Manual, &Clock).unwrap();
        let (title, position): (String, i64) = db.query_row(
            "SELECT g.title,n.position FROM app_space_groups g JOIN app_space_nodes n ON n.group_id=g.id",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(title, "검진");
        assert_eq!(position, -1);
    }
}
