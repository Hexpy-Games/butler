mod tree_mutations;
mod undo;

pub(super) use tree_mutations::save_nodes;

use rusqlite::Connection;
use serde_json::json;

use super::contracts::{
    AppSpaceCommand, AppSpaceMutationResult, AppSpaceOrigin, AppSpaceSmartNotice,
};
use super::reader;
use crate::gateway::application::{AppIdentityClock, events, storage::AppStorageError};
use crate::gateway::{AppEventEnvelope, GatewayApplicationError};

#[derive(Clone, Default)]
pub(super) struct SpaceHistory {
    pub undo: Option<Undo>,
    pub smart_notice: Option<AppSpaceSmartNotice>,
}

#[derive(Clone)]
pub(super) struct Undo {
    pub(super) token: String,
    pub(super) revision: i64,
    nodes: Vec<super::contracts::AppSpaceNode>,
    groups: Vec<super::contracts::AppSpaceGroup>,
    remove_nodes: Vec<String>,
    remove_groups: Vec<String>,
}

pub(super) struct Outcome {
    pub result: AppSpaceMutationResult,
    pub event: AppEventEnvelope,
    pub history: SpaceHistory,
}

pub(super) fn execute(
    db: &mut Connection,
    clock: &dyn AppIdentityClock,
    mut history: SpaceHistory,
    command: AppSpaceCommand,
    origin: AppSpaceOrigin,
    title: &str,
) -> Result<Outcome, GatewayApplicationError> {
    let tx = db
        .transaction()
        .map_err(|error| app_error(AppStorageError::sqlite(error)))?;
    let before = reader::read(&tx).map_err(app_error)?;
    if before.revision != command.expected_revision() {
        return Err(super::tree::error(
            "space_changed",
            "목록이 변경되었습니다. 최신 목록에서 다시 시도해 주세요.",
        ));
    }
    let group_id = match &command {
        AppSpaceCommand::Create {
            title, parent_key, ..
        } => Some(tree_mutations::create_group(
            &tx,
            &before,
            title,
            parent_key.as_deref(),
            origin,
            clock,
        )?),
        AppSpaceCommand::Rename {
            group_id, title, ..
        } => {
            tree_mutations::rename_group(&tx, &before, group_id, title, clock)?;
            None
        }
        AppSpaceCommand::Dissolve { group_id, .. } => {
            tree_mutations::dissolve_group(&tx, &before, group_id)?;
            None
        }
        AppSpaceCommand::Move {
            source_key,
            target_key,
            position,
            ..
        } => {
            let nodes = super::tree::move_nodes(
                &before,
                source_key,
                target_key.as_deref(),
                *position,
                origin == AppSpaceOrigin::Smart,
            )?;
            tree_mutations::save_nodes(&tx, &nodes)?;
            None
        }
        AppSpaceCommand::Group {
            source_key,
            target_key,
            title: requested_title,
            ..
        } => Some(tree_mutations::group_sessions(
            &tx,
            &before,
            source_key,
            target_key,
            requested_title.as_deref().unwrap_or(title),
            origin,
            clock,
        )?),
        AppSpaceCommand::Undo { undo_token, .. } => {
            undo::restore(&tx, &mut history, undo_token, before.revision, clock)?;
            None
        }
        AppSpaceCommand::Pin {
            node_key, pinned, ..
        } => {
            tree_mutations::pin(&tx, &before, node_key, *pinned)?;
            None
        }
    };
    let mut after = reader::read(&tx).map_err(app_error)?;
    let next_undo = if !matches!(
        &command,
        AppSpaceCommand::Undo { .. } | AppSpaceCommand::Pin { .. }
    ) && after.revision != before.revision
    {
        Some(undo::inverse_change(&before, &after, clock.new_uuid()))
    } else {
        None
    };
    history.undo = next_undo.clone();
    history.smart_notice = match (origin, next_undo) {
        (AppSpaceOrigin::Smart, Some(undo)) => Some(AppSpaceSmartNotice {
            title: title.to_owned(),
            undo_token: undo.token,
            revision: undo.revision,
        }),
        _ => None,
    };
    if let (Some(undo), Some(notice)) = (&history.undo, &history.smart_notice)
        && undo.revision == after.revision
        && notice.revision == after.revision
    {
        after.smart_notice = Some(notice.clone());
    }
    let event = events::append_unpublished(
        &tx,
        "space.changed",
        None,
        json!({"revision":after.revision})
            .as_object()
            .cloned()
            .expect("space event is an object"),
        &clock.now_iso(),
    )
    .map_err(app_error)?;
    tx.commit()
        .map_err(|error| app_error(AppStorageError::sqlite(error)))?;
    Ok(Outcome {
        result: AppSpaceMutationResult {
            space: after,
            undo_token: history.undo.as_ref().map(|undo| undo.token.clone()),
            group_id,
        },
        event,
        history,
    })
}

fn app_error(error: AppStorageError) -> GatewayApplicationError {
    super::super::app_error(error)
}
