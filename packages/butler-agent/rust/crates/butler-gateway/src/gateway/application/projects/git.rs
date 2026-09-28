//! A project folder's Git state (#231): the project list reads only
//! `HEAD` from the file system (no process, cheap for every project); the
//! project dashboard also asks the host for `git status` (dirty, ahead,
//! behind), bounded in time.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::AppProjectGit;
use crate::gateway::application::AppApplication;

/// How long the dashboard waits for `git status`.
const DETAIL_TIMEOUT: Duration = Duration::from_secs(3);
/// Branch names are shown to the user; longer ones are cut.
const MAX_BRANCH_CHARS: usize = 80;

/// Whether `workspace` is in a Git repository and its checked-out branch,
/// from the repository's `HEAD` file.
pub(super) fn head(workspace: &Path) -> AppProjectGit {
    let Some(head) =
        git_dir(workspace).and_then(|dir| std::fs::read_to_string(dir.join("HEAD")).ok())
    else {
        return AppProjectGit::default();
    };
    AppProjectGit {
        is_repo: true,
        branch: branch_of(&head),
        ..AppProjectGit::default()
    }
}

/// [`head`] for each folder, off the async runtime.
pub(super) async fn heads(workspaces: Vec<PathBuf>) -> Vec<AppProjectGit> {
    let count = workspaces.len();
    tokio::task::spawn_blocking(move || workspaces.iter().map(|path| head(path)).collect())
        .await
        .unwrap_or_else(|_| vec![AppProjectGit::default(); count])
}

/// The full state for the dashboard: [`head`], then the host's `git
/// status` when it answers in time (otherwise dirty/ahead/behind stay
/// unknown).
pub(super) async fn detail(application: &AppApplication, workspace: &str) -> AppProjectGit {
    let mut git = heads(vec![PathBuf::from(workspace)])
        .await
        .pop()
        .unwrap_or_default();
    if !git.is_repo {
        return git;
    }
    let cancellation = CancellationToken::new();
    let status = application
        .dependencies
        .session_workspaces
        .project_git(workspace.to_owned(), cancellation.clone());
    let answered = tokio::time::timeout(DETAIL_TIMEOUT, status).await;
    cancellation.cancel();
    if let Ok(Ok(Some(status))) = answered {
        git.branch = status.branch;
        git.dirty = status.dirty;
        git.ahead = status.ahead;
        git.behind = status.behind;
    }
    git
}

/// The repository directory of `workspace`: the nearest `.git` directory
/// of it or an ancestor, or the one a `.git` file (`gitdir: ..`, as in
/// linked worktrees and submodules) names.
fn git_dir(workspace: &Path) -> Option<PathBuf> {
    workspace.ancestors().find_map(|folder| {
        let candidate = folder.join(".git");
        let metadata = std::fs::metadata(&candidate).ok()?;
        if metadata.is_dir() {
            return Some(candidate);
        }
        let pointer = std::fs::read_to_string(&candidate).ok()?;
        let target = pointer.trim().strip_prefix("gitdir:")?.trim();
        Some(folder.join(target))
    })
}

/// `ref: refs/heads/<branch>` names the branch; anything else (a commit id)
/// is a detached HEAD.
fn branch_of(head: &str) -> Option<String> {
    let branch = head
        .trim()
        .strip_prefix("ref:")?
        .trim()
        .strip_prefix("refs/heads/")?;
    let branch: String = branch
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_BRANCH_CHARS)
        .collect();
    (!branch.is_empty()).then_some(branch)
}
