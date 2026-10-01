//! A project folder's Git status in one `git status --porcelain=v2
//! --branch` call: branch, uncommitted changes, and commits ahead of and
//! behind the upstream branch.
//!
//! The folder may be a repository someone else prepared, so the read must
//! not run anything the repository's own config names:
//!
//! - `core.fsmonitor` (a hook program) and the untracked cache are turned
//!   off on the command line, which overrides every config file;
//! - no optional locks (`--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`), so
//!   the index is never written and no index hook runs;
//! - submodules are not visited (they have configs of their own);
//! - the system config is skipped (`GIT_CONFIG_NOSYSTEM=1`) and Git never
//!   prompts;
//! - a repository whose config defines content filters (`filter.*`, which
//!   `git status` may run to compare file contents) or includes other
//!   config files (`include`, `includeIf`) is not read at all: its status
//!   stays unknown.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::workspace::{
    CommandStep, Commands, StructuredCommandInput, WorkspaceCode, WorkspaceError, WorkspaceFiles,
    WorkspaceResult,
};

const STATUS_ARGS: [&str; 10] = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "--no-optional-locks",
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=normal",
    "--ignore-submodules=all",
];
const STATUS_ENVIRONMENT: [(&str, &str); 3] = [
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("GIT_TERMINAL_PROMPT", "0"),
];
/// The caller bounds the time too; this caps a call nobody cancels.
const STATUS_TIMEOUT_MS: f64 = 10_000.0;
/// Branch names are shown to the user; longer ones are cut.
const MAX_BRANCH_CHARS: usize = 80;
/// Config files larger than this are not inspected (and not trusted).
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

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
/// not in one, its config could run programs, Git is missing, or the
/// command failed or was aborted.
pub(super) async fn project_git_status(
    commands: &Commands,
    files: &WorkspaceFiles,
    host_environment: &Arc<HashMap<String, String>>,
    workspace_path: &str,
    abort: CancellationToken,
) -> WorkspaceResult<Option<ProjectGitStatus>> {
    let workspace = PathBuf::from(workspace_path);
    let unsafe_config = files
        .run(move || repository_config_runs_programs(&workspace))
        .await
        .map_err(WorkspaceError::from)?;
    if unsafe_config {
        return Ok(None);
    }
    let input = StructuredCommandInput {
        steps: vec![CommandStep {
            executable: "git".into(),
            arguments: STATUS_ARGS
                .iter()
                .map(|argument| (*argument).into())
                .collect(),
        }],
        cwd: Some(PathBuf::from(workspace_path)),
        environment: STATUS_ENVIRONMENT
            .iter()
            .map(|(name, value)| ((*name).to_owned(), Some((*value).to_owned())))
            .collect(),
        host_environment: (**host_environment).clone(),
        inherit_environment: true,
        stdin: String::new(),
        timeout_ms: Some(STATUS_TIMEOUT_MS),
        abort,
        legacy: None,
    };
    let output = commands
        .submit_structured(input)
        .map_err(WorkspaceError::from)?
        .await
        .map_err(|source| {
            WorkspaceError::new(
                WorkspaceCode::WorkspaceRecoveryCommandLost,
                "Git result lost",
            )
            .with_source(source)
        })?;
    let failed = output.cancelled
        || output.timed_out
        || output.error.is_some()
        || output.exit_code != Some(0);
    Ok((!failed).then(|| parse(&output.stdout)))
}

/// Whether the repository's own config (the `config` and `config.worktree`
/// of its Git directory and, for a linked worktree, of the main one)
/// defines content filters or includes other files. Unreadable or
/// oversized config counts as unsafe.
fn repository_config_runs_programs(workspace: &Path) -> bool {
    let Some(git_dir) = git_dir(workspace) else {
        return false;
    };
    let mut directories = vec![git_dir.clone()];
    if let Ok(common) = std::fs::read_to_string(git_dir.join("commondir")) {
        directories.push(git_dir.join(common.trim()));
    }
    directories.iter().any(|directory| {
        ["config", "config.worktree"].iter().any(|name| {
            let path = directory.join(name);
            match std::fs::metadata(&path) {
                Err(_) => false,
                Ok(metadata) if metadata.len() > MAX_CONFIG_BYTES => true,
                Ok(_) => std::fs::read_to_string(&path).map_or(true, |text| runs_programs(&text)),
            }
        })
    })
}

/// The Git directory of the repository `workspace` is in: the nearest
/// `.git` directory, or the one a `.git` file (`gitdir: ..`) names.
fn git_dir(workspace: &Path) -> Option<PathBuf> {
    workspace.ancestors().find_map(|folder| {
        let candidate = folder.join(".git");
        let metadata = std::fs::metadata(&candidate).ok()?;
        if metadata.is_dir() {
            return Some(candidate);
        }
        let pointer = std::fs::read_to_string(&candidate).ok()?;
        Some(folder.join(pointer.trim().strip_prefix("gitdir:")?.trim()))
    })
}

/// Whether config text has a `[filter ...]`, `[include]` or `[includeIf
/// ...]` section (section names are case-insensitive).
fn runs_programs(config: &str) -> bool {
    config.lines().any(|line| {
        let Some(section) = line.trim_start().strip_prefix('[') else {
            return false;
        };
        let name: String = section
            .chars()
            .take_while(|character| character.is_ascii_alphanumeric() || *character == '-')
            .collect::<String>()
            .to_ascii_lowercase();
        matches!(name.as_str(), "filter" | "include" | "includeif")
    })
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
