//! A project folder's Git status in one `git status --porcelain=v2
//! --branch` call: branch, uncommitted changes, and commits ahead of and
//! behind the upstream branch.

use std::collections::HashMap;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::git::git;
use crate::workspace::{Commands, WorkspaceResult};

/// Takes no index lock, so a read never blocks the user's own Git commands.
const STATUS_ARGS: [&str; 5] = [
    "--no-optional-locks",
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=normal",
];
/// Branch names are shown to the user; longer ones are cut.
const MAX_BRANCH_CHARS: usize = 80;

/// The Git status of a project folder.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectGitStatus {
    /// The checked-out branch; `None` for a detached HEAD.
    pub branch: Option<String>,
    /// Any tracked change or untracked file.
    pub dirty: bool,
    /// Commits the branch has that its upstream lacks (`None`: no upstream).
    pub ahead: Option<u32>,
    /// Commits the upstream has that the branch lacks (`None`: no upstream).
    pub behind: Option<u32>,
}

/// The status of the repository `workspace_path` is in; `None` when it is
/// not in one, Git is missing, or the command failed or was aborted.
pub(super) async fn project_git_status(
    commands: &Commands,
    host_environment: &Arc<HashMap<String, String>>,
    workspace_path: &str,
    abort: CancellationToken,
) -> WorkspaceResult<Option<ProjectGitStatus>> {
    let output = git(
        commands,
        host_environment,
        workspace_path,
        &STATUS_ARGS,
        abort,
    )
    .await?;
    let failed = output.cancelled
        || output.timed_out
        || output.error.is_some()
        || output.exit_code != Some(0);
    Ok((!failed).then(|| parse(&output.stdout)))
}

/// Reads `git status --porcelain=v2 --branch` output.
fn parse(stdout: &str) -> ProjectGitStatus {
    let mut status = ProjectGitStatus::default();
    for line in stdout.lines() {
        let Some(header) = line.strip_prefix("# ") else {
            status.dirty |= !line.trim().is_empty();
            continue;
        };
        if let Some(head) = header.strip_prefix("branch.head ") {
            status.branch = (head != "(detached)").then(|| public_branch(head));
        } else if let Some(counts) = header.strip_prefix("branch.ab ") {
            let mut counts = counts.split_whitespace();
            status.ahead = counts.next().and_then(|ahead| count(ahead, '+'));
            status.behind = counts.next().and_then(|behind| count(behind, '-'));
        }
    }
    status
}

fn count(value: &str, sign: char) -> Option<u32> {
    value.strip_prefix(sign)?.parse().ok()
}

/// The branch name without control characters, at most 80 characters.
fn public_branch(name: &str) -> String {
    name.trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_BRANCH_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Format pin: `git status --porcelain=v2 --branch` output.
    #[test]
    fn porcelain_v2_branch_output_is_read() {
        let cases = [
            (
                "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n",
                (Some("main"), false, Some(2), Some(1)),
            ),
            (
                "# branch.oid abc\n# branch.head feature/x\n1 .M N... 100644 100644 100644 a b src/lib.rs\n? notes.txt\n",
                (Some("feature/x"), true, None, None),
            ),
            (
                "# branch.oid abc\n# branch.head (detached)\n",
                (None, false, None, None),
            ),
            (
                "# branch.oid (initial)\n# branch.head main\n? new.txt\n",
                (Some("main"), true, None, None),
            ),
        ];
        for (stdout, (branch, dirty, ahead, behind)) in cases {
            let status = parse(stdout);
            assert_eq!(status.branch.as_deref(), branch, "{stdout}");
            assert_eq!(status.dirty, dirty, "{stdout}");
            assert_eq!((status.ahead, status.behind), (ahead, behind), "{stdout}");
        }
    }
}
