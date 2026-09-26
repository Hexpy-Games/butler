use super::contracts::{AppSpaceNode, AppSpacePosition, AppSpaceView};
use crate::gateway::GatewayApplicationError;

pub(super) fn error(code: &'static str, message: &'static str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: code.to_owned(),
        message: message.to_owned(),
    }
}

pub(in crate::gateway::application) fn require_node<'a>(
    view: &'a AppSpaceView,
    key: &str,
) -> Result<&'a AppSpaceNode, GatewayApplicationError> {
    view.nodes
        .iter()
        .find(|node| node.key == key)
        .ok_or_else(|| {
            error(
                "space_item_missing",
                "항목을 찾을 수 없습니다. 목록을 새로 확인해 주세요.",
            )
        })
}

pub(super) fn container_scope(
    view: &AppSpaceView,
    parent_key: Option<&str>,
) -> Result<Option<String>, GatewayApplicationError> {
    let Some(parent_key) = parent_key else {
        return Ok(None);
    };
    let parent = require_node(view, parent_key)?;
    match parent.kind.as_str() {
        "session" => Err(error(
            "space_invalid_parent",
            "대화 안에 항목을 넣을 수 없습니다.",
        )),
        "project" => Ok(Some(parent.entity_id.clone())),
        _ => Ok(parent.scope_project_id.clone()),
    }
}

fn require_placement(
    view: &AppSpaceView,
    source: &AppSpaceNode,
    parent_key: Option<&str>,
) -> Result<(), GatewayApplicationError> {
    if source.scope_project_id != container_scope(view, parent_key)? {
        return Err(error(
            "space_project_boundary",
            "프로젝트 소속을 바꾸려면 프로젝트 이동을 사용해 주세요.",
        ));
    }
    let mut cursor = parent_key;
    while let Some(key) = cursor {
        if key == source.key {
            return Err(error(
                "space_cycle",
                "항목을 자신의 하위로 옮길 수 없습니다.",
            ));
        }
        cursor = view
            .nodes
            .iter()
            .find(|node| node.key == key)
            .and_then(|node| node.parent_key.as_deref());
    }
    Ok(())
}

pub(super) fn ordered_children(view: &AppSpaceView, parent_key: Option<&str>) -> Vec<AppSpaceNode> {
    let mut nodes = view
        .nodes
        .iter()
        .filter(|node| node.parent_key.as_deref() == parent_key)
        .cloned()
        .collect::<Vec<_>>();
    nodes.sort_by(|left, right| {
        left.position
            .cmp(&right.position)
            .then(left.key.cmp(&right.key))
    });
    nodes
}

pub(super) fn move_nodes(
    view: &AppSpaceView,
    source_key: &str,
    target_key: Option<&str>,
    position: AppSpacePosition,
    prepend: bool,
) -> Result<Vec<AppSpaceNode>, GatewayApplicationError> {
    let source = require_node(view, source_key)?.clone();
    if target_key == Some(source_key) {
        return Ok(Vec::new());
    }
    let target = target_key
        .map(|key| require_node(view, key))
        .transpose()?
        .cloned();
    if target.is_none() && !matches!(position, AppSpacePosition::Inside) {
        return Err(error("space_invalid_target", "이동 위치를 선택해 주세요."));
    }
    let parent_key = match position {
        AppSpacePosition::Inside => target_key.map(str::to_owned),
        AppSpacePosition::Before | AppSpacePosition::After => {
            target.as_ref().and_then(|node| node.parent_key.clone())
        }
    };
    require_placement(view, &source, parent_key.as_deref())?;
    let from = ordered_children(view, source.parent_key.as_deref())
        .into_iter()
        .filter(|node| node.key != source_key)
        .collect::<Vec<_>>();
    let same_parent = source.parent_key == parent_key;
    let mut to = if same_parent {
        from.clone()
    } else {
        ordered_children(view, parent_key.as_deref())
    };
    let index = match position {
        AppSpacePosition::Inside => {
            if prepend {
                0
            } else {
                to.len()
            }
        }
        AppSpacePosition::Before | AppSpacePosition::After => target_key
            .and_then(|target_key| to.iter().position(|node| node.key == target_key))
            .map(|index| index + usize::from(matches!(position, AppSpacePosition::After)))
            .unwrap_or(to.len()),
    };
    let mut moved = source;
    moved.parent_key = parent_key;
    moved.manual_placement = true;
    to.insert(index, moved);
    let normalize = |nodes: Vec<AppSpaceNode>| {
        nodes
            .into_iter()
            .enumerate()
            .map(|(index, mut node)| {
                node.position = index as i64;
                node
            })
            .collect::<Vec<_>>()
    };
    if same_parent {
        Ok(normalize(to))
    } else {
        let mut changed = normalize(from);
        changed.extend(normalize(to));
        Ok(changed)
    }
}
