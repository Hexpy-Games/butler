//! Target validation and durable destination facts for a session relocation.

use rusqlite::{Connection, OptionalExtension};

use super::{
    contracts::{AppSpacePosition, AppSpaceView},
    tree,
};
use crate::gateway::GatewayApplicationError;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::gateway::application) struct AppRelocationProject {
    pub id: String,
    pub display_name: String,
    pub workspace_path: String,
    pub ledger_project_id: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::gateway::application) struct AppRelocationDestination {
    pub parent_key: Option<String>,
    pub target_key: Option<String>,
    pub position: AppSpacePosition,
    pub project: Option<AppRelocationProject>,
}

pub(in crate::gateway::application) fn destination(
    db: &Connection,
    view: &AppSpaceView,
    session_id: &str,
    target_key: Option<&str>,
    position: AppSpacePosition,
) -> Result<AppRelocationDestination, GatewayApplicationError> {
    let source_key = format!("s:{session_id}");
    let source = tree::require_node(view, &source_key)?;
    let target = target_key
        .map(|key| tree::require_node(view, key))
        .transpose()?;
    if target.is_some_and(|node| node.key == source_key)
        || (target.is_none() && position != AppSpacePosition::Inside)
    {
        return Err(tree::error(
            "space_invalid_target",
            "다른 이동 위치를 선택해 주세요.",
        ));
    }
    let parent_key = match position {
        AppSpacePosition::Inside => target_key.map(str::to_owned),
        AppSpacePosition::Before | AppSpacePosition::After => {
            target.and_then(|node| node.parent_key.clone())
        }
    };
    let project_id = tree::container_scope(view, parent_key.as_deref())?;
    if project_id.as_deref() == source.scope_project_id.as_deref() {
        return Err(tree::error(
            "same_session_context",
            "같은 프로젝트 안에서는 목록 이동을 사용해 주세요.",
        ));
    }
    let project = project_id
        .as_deref()
        .map(|id| active_project(db, id))
        .transpose()?
        .flatten();
    if project_id.is_some() && project.is_none() {
        return Err(tree::error(
            "project_unavailable",
            "사용 가능한 프로젝트를 선택해 주세요.",
        ));
    }
    Ok(AppRelocationDestination {
        parent_key,
        target_key: target_key.map(str::to_owned),
        position,
        project,
    })
}

fn active_project(
    db: &Connection,
    id: &str,
) -> Result<Option<AppRelocationProject>, GatewayApplicationError> {
    db.query_row(
        "SELECT id,display_name,workspace_path,ledger_project_id FROM projects WHERE id=?1 AND archived=0",
        [id],
        |row| {
            Ok(AppRelocationProject {
                id: row.get(0)?,
                display_name: row.get(1)?,
                workspace_path: row.get(2)?,
                ledger_project_id: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|error| crate::gateway::application::app_error(
        crate::gateway::application::storage::AppStorageError::sqlite(error),
    ))
}
