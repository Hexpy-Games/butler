//! Identity-checked cleanup for a prepared relocation worktree.

use super::{Owner, RelocationWorkspacePlan};
use crate::workspace::WorkspaceCode;
use crate::workspace::WorkspaceResult;

pub(super) async fn discard(owner: &Owner, plan: RelocationWorkspacePlan) -> WorkspaceResult<bool> {
    let session_id = plan.runtime_session_id.clone();
    let lock = owner.session_lock(&session_id);
    let result = {
        let _guard = lock.lock().await;
        discard_unlocked(owner, plan).await
    };
    owner.release_session_lock(&session_id, &lock);
    result
}

async fn discard_unlocked(owner: &Owner, plan: RelocationWorkspacePlan) -> WorkspaceResult<bool> {
    let Some(marker) = plan.marker.as_ref().filter(|_| plan.created) else {
        return Ok(true);
    };
    owner.validate_plan_path(&plan).await?;
    let git = owner.git();
    let Ok(entries) = git
        .list(&marker.repository_anchor_path, owner.shutdown.child_token())
        .await?
    else {
        return Ok(false);
    };
    let mut owned = false;
    for entry in entries {
        if entry.branch.as_deref() == Some(marker.branch.as_str())
            && git
                .same_path(&entry.path.to_string_lossy(), &plan.workspace_path)
                .await?
        {
            owned = true;
            break;
        }
    }
    if !owned {
        return Ok(!git.occupied(&plan.workspace_path).await?);
    }
    match git
        .dirty(&plan.workspace_path, owner.shutdown.child_token())
        .await?
    {
        Ok(false) => {}
        _ => return Ok(false),
    }
    let removed = git
        .run(
            &marker.repository_anchor_path,
            vec![
                "worktree".into(),
                "remove".into(),
                plan.workspace_path.clone(),
            ],
            owner.shutdown.child_token(),
        )
        .await?;
    if super::super::git::command_failure(&removed, WorkspaceCode::WorktreeCleanupFailed).is_some()
    {
        return Ok(false);
    }
    let _ = git
        .run(
            &marker.repository_anchor_path,
            vec!["branch".into(), "-d".into(), marker.branch.clone()],
            owner.shutdown.child_token(),
        )
        .await;
    Ok(true)
}
