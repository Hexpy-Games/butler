//! What a pending authority request would do, as structured data (#235):
//! the kind of action, its targets, how many, a few examples and a risk
//! level. The App composes the sentence in the user's language; nothing
//! here is display text, and no absolute path leaves the machine: a folder
//! is named by its label (the folder name, as projects show it), a file by
//! its path inside the workspace.

mod command_risk;

use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use butler_core::tool_protocol::ToolName;
use command_risk::command_risk;

/// Most targets and examples one approval lists.
const MAX_TARGETS: usize = 20;
const MAX_EXAMPLES: usize = 3;
/// A command example is cut after this many characters.
const MAX_EXAMPLE_CHARS: usize = 200;
/// A folder label is cut after this many characters.
const MAX_LABEL_CHARS: usize = 80;
/// The label of a workspace whose folder has no usable name.
const FALLBACK_LABEL: &str = "workspace";

/// The structured summary of a pending request (`approval` in its JSON).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorityApproval {
    pub action_kind: ApprovalActionKind,
    /// What the action touches, the folder first where there is one.
    pub targets: Vec<ApprovalTarget>,
    /// How many items (files, commands, calls) the action covers.
    pub count: u32,
    /// Up to three concrete items: file paths or the command line.
    pub examples: Vec<String>,
    pub risk: ApprovalRisk,
}

/// What kind of action waits for the user.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalActionKind {
    /// Create or change files in the project folder.
    EditFiles,
    /// Run a command that changes the workspace.
    RunCommand,
    /// Run a command that reaches the network.
    NetworkCommand,
    /// Call a tool of a connected MCP server.
    UseConnector,
    /// Create, delete or run schedules.
    ManageSchedule,
    /// Record project work (plans, tasks, attempts, reviews).
    UpdateProject,
    /// Start a conversation on a topic.
    StartConversation,
    /// Restart the Butler service.
    RestartService,
    /// Give the conversation its own Git worktree.
    CreateWorktree,
    /// Any other reviewed operation.
    Other,
}

/// One thing an action touches.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalTarget {
    pub kind: ApprovalTargetKind,
    /// A folder label (`garden`, `garden/app`), a path inside the
    /// workspace, `server/tool` for a connector, or the operation's own
    /// target name. Never an absolute path.
    pub path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalTargetKind {
    Folder,
    File,
    Connector,
    Schedule,
    Project,
    Service,
    Other,
}

/// How careful the user should be.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalRisk {
    Low,
    Medium,
    High,
}

/// The request's facts the summary reads.
#[derive(Clone, Copy)]
pub(super) struct ApprovalFacts<'a> {
    pub(super) capability: &'a str,
    pub(super) target: &'a str,
    // Passthrough: the normalized tool input, shaped by each tool.
    pub(super) input: &'a Value,
    pub(super) workspace: &'a str,
}

pub(super) fn summarize(facts: ApprovalFacts<'_>) -> AuthorityApproval {
    match facts.capability {
        "run_command" => command(facts, ApprovalActionKind::RunCommand),
        "run_command_remote_observation" => command(facts, ApprovalActionKind::NetworkCommand),
        "call_mcp_tool" => single(
            ApprovalActionKind::UseConnector,
            ApprovalTargetKind::Connector,
            facts.target.strip_prefix("mcp:").unwrap_or(facts.target),
            ApprovalRisk::High,
        ),
        "start_topic_conversation" => single(
            ApprovalActionKind::StartConversation,
            ApprovalTargetKind::Other,
            facts.target,
            ApprovalRisk::Low,
        ),
        "request_service_restart" => single(
            ApprovalActionKind::RestartService,
            ApprovalTargetKind::Service,
            "butler",
            ApprovalRisk::Medium,
        ),
        "bind_session_git_worktree" => single(
            ApprovalActionKind::CreateWorktree,
            ApprovalTargetKind::Folder,
            &workspace_label(facts.workspace),
            ApprovalRisk::Low,
        ),
        capability => by_tool(facts, ToolName::parse(capability)),
    }
}

fn by_tool(facts: ApprovalFacts<'_>, tool: Option<ToolName>) -> AuthorityApproval {
    let (kind, target, risk) = match tool {
        Some(ToolName::WriteFile | ToolName::EditFile) => return file_edits(facts),
        Some(ToolName::DeleteAutomation) => (
            ApprovalActionKind::ManageSchedule,
            ApprovalTargetKind::Schedule,
            ApprovalRisk::High,
        ),
        Some(ToolName::CreateAutomation | ToolName::RunDueAutomations) => (
            ApprovalActionKind::ManageSchedule,
            ApprovalTargetKind::Schedule,
            ApprovalRisk::Medium,
        ),
        Some(
            ToolName::ProjectLedgerCreate
            | ToolName::ProjectLedgerUpdate
            | ToolName::ProjectLedgerWorkUpdate
            | ToolName::ProjectLedgerWorkComplete
            | ToolName::CompleteProjectWork
            | ToolName::ProjectLedgerTaskUpdate
            | ToolName::ProjectLedgerTaskComplete
            | ToolName::ProjectLedgerAttemptStart
            | ToolName::ProjectLedgerAttemptSucceed
            | ToolName::ProjectLedgerAttemptFail,
        ) => (
            ApprovalActionKind::UpdateProject,
            ApprovalTargetKind::Project,
            ApprovalRisk::Low,
        ),
        _ => (
            ApprovalActionKind::Other,
            ApprovalTargetKind::Other,
            ApprovalRisk::Medium,
        ),
    };
    single(kind, target, facts.target, risk)
}

/// `write_file` (`path`) or `edit_file` (`path`, or `edits[].path`): the
/// folder, then each distinct file.
fn file_edits(facts: ApprovalFacts<'_>) -> AuthorityApproval {
    let mut files: Vec<String> = Vec::new();
    let entries = match facts.input.get("edits").and_then(Value::as_array) {
        Some(edits) => edits.iter().collect(),
        None => vec![facts.input],
    };
    for entry in entries {
        if let Some(path) = entry.get("path").and_then(Value::as_str) {
            let path = inside_workspace(path, facts.workspace);
            if !path.is_empty() && !files.contains(&path) {
                files.push(path);
            }
        }
    }
    let mut targets = vec![folder(workspace_label(facts.workspace))];
    targets.extend(files.iter().take(MAX_TARGETS).map(|path| ApprovalTarget {
        kind: ApprovalTargetKind::File,
        path: path.clone(),
    }));
    AuthorityApproval {
        action_kind: ApprovalActionKind::EditFiles,
        targets,
        count: saturating_count(files.len()),
        examples: files.into_iter().take(MAX_EXAMPLES).collect(),
        risk: ApprovalRisk::Medium,
    }
}

/// A command: its folder (the workspace label, plus `cwd` inside it) and
/// the command line.
fn command(facts: ApprovalFacts<'_>, kind: ApprovalActionKind) -> AuthorityApproval {
    let line = facts
        .input
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let label = workspace_label(facts.workspace);
    let cwd = facts
        .input
        .get("cwd")
        .and_then(Value::as_str)
        .map(|cwd| inside_workspace(cwd, facts.workspace))
        .unwrap_or_default();
    let folder_path = if cwd.is_empty() {
        label
    } else {
        format!("{label}/{cwd}")
    };
    AuthorityApproval {
        action_kind: kind,
        targets: vec![folder(folder_path)],
        count: 1,
        examples: (!line.is_empty())
            .then(|| line.chars().take(MAX_EXAMPLE_CHARS).collect())
            .into_iter()
            .collect(),
        risk: command_risk(line),
    }
}

fn single(
    action_kind: ApprovalActionKind,
    kind: ApprovalTargetKind,
    path: &str,
    risk: ApprovalRisk,
) -> AuthorityApproval {
    AuthorityApproval {
        action_kind,
        targets: vec![ApprovalTarget {
            kind,
            path: path.to_owned(),
        }],
        count: 1,
        examples: Vec::new(),
        risk,
    }
}

fn folder(path: String) -> ApprovalTarget {
    ApprovalTarget {
        kind: ApprovalTargetKind::Folder,
        path,
    }
}

/// The workspace folder's name without control characters, as project
/// labels are shown (at most 80 characters).
fn workspace_label(workspace: &str) -> String {
    let name: String = Path::new(workspace)
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_LABEL_CHARS)
        .collect();
    if name.trim().is_empty() {
        FALLBACK_LABEL.to_owned()
    } else {
        name
    }
}

/// `path` relative to the workspace, normalized (no `.` or `..`). A path
/// that is absolute outside the workspace, or climbs out of it, is named by
/// its file name only.
fn inside_workspace(path: &str, workspace: &str) -> String {
    let path = Path::new(path);
    let relative = if path.is_absolute() {
        match path.strip_prefix(workspace) {
            Ok(inner) => inner,
            Err(_) => return file_name(path),
        }
    } else {
        path
    };
    let mut parts: Vec<String> = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::ParentDir => {
                if parts.pop().is_none() {
                    return file_name(path);
                }
            }
            _ => {}
        }
    }
    parts.join("/")
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn saturating_count(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// Pins one summary per action kind and the command-risk table (called by
/// the authority projection test, `authority/tests/bun_oracle.rs`).
#[cfg(test)]
pub(super) mod pinned {
    use serde_json::json;

    use super::*;

    const WORKSPACE: &str = "/Users/someone/work/garden";

    fn summary(capability: &str, target: &str, input: &Value) -> Value {
        serde_json::to_value(summarize(ApprovalFacts {
            capability,
            target,
            input,
            workspace: WORKSPACE,
        }))
        .unwrap()
    }

    /// One summary per action kind, as the App reads them, with no absolute
    /// path; then the command-risk table.
    pub(in crate::btcc::authority) fn assert_approval_summaries() {
        let edits = json!({"edits": [
            {"path": "/Users/someone/work/garden/a.txt"}, {"path": "b.txt"}, {"path": "./a.txt"},
            {"path": "notes/../c.txt"}, {"path": "/etc/passwd"}]});
        let cases = [
            (
                summary("write_file", "notes.txt", &json!({"path": "notes.txt"})),
                json!({"action_kind": "edit_files", "count": 1, "examples": ["notes.txt"], "risk": "medium",
                    "targets": [{"kind": "folder", "path": "garden"}, {"kind": "file", "path": "notes.txt"}]}),
            ),
            (
                summary("edit_file", "batch", &edits),
                json!({"action_kind": "edit_files", "count": 4, "examples": ["a.txt", "b.txt", "c.txt"], "risk": "medium",
                    "targets": [{"kind": "folder", "path": "garden"}, {"kind": "file", "path": "a.txt"},
                                {"kind": "file", "path": "b.txt"}, {"kind": "file", "path": "c.txt"},
                                {"kind": "file", "path": "passwd"}]}),
            ),
            (
                summary(
                    "run_command",
                    "workspace-command:app",
                    &json!({"command": "npm test", "cwd": "app/./src/..", "state_effect": "mutation"}),
                ),
                json!({"action_kind": "run_command", "count": 1, "examples": ["npm test"], "risk": "medium",
                    "targets": [{"kind": "folder", "path": "garden/app"}]}),
            ),
            (
                summary(
                    "run_command",
                    "workspace-command:..",
                    &json!({"command": "rm -rf build", "cwd": "../..", "state_effect": "mutation"}),
                ),
                json!({"action_kind": "run_command", "count": 1, "examples": ["rm -rf build"], "risk": "high",
                    "targets": [{"kind": "folder", "path": "garden"}]}),
            ),
            (
                summary(
                    "run_command_remote_observation",
                    "remote-observation-command:.",
                    &json!({"command": "curl https://example.com", "cwd": "."}),
                ),
                json!({"action_kind": "network_command", "count": 1, "examples": ["curl https://example.com"],
                    "risk": "medium", "targets": [{"kind": "folder", "path": "garden"}]}),
            ),
            (
                summary("call_mcp_tool", "mcp:e2e/e2e_echo", &json!({})),
                json!({"action_kind": "use_connector", "count": 1, "examples": [], "risk": "high",
                    "targets": [{"kind": "connector", "path": "e2e/e2e_echo"}]}),
            ),
            (
                summary("delete_automation", "automation-1", &json!({})),
                json!({"action_kind": "manage_schedule", "count": 1, "examples": [], "risk": "high",
                    "targets": [{"kind": "schedule", "path": "automation-1"}]}),
            ),
            (
                summary("project_ledger_attempt_start", "ledger:work", &json!({})),
                json!({"action_kind": "update_project", "count": 1, "examples": [], "risk": "low",
                    "targets": [{"kind": "project", "path": "ledger:work"}]}),
            ),
            (
                summary("request_service_restart", "service", &json!({})),
                json!({"action_kind": "restart_service", "count": 1, "examples": [], "risk": "medium",
                    "targets": [{"kind": "service", "path": "butler"}]}),
            ),
            (
                summary("bind_session_git_worktree", "worktree", &json!({})),
                json!({"action_kind": "create_worktree", "count": 1, "examples": [], "risk": "low",
                    "targets": [{"kind": "folder", "path": "garden"}]}),
            ),
            (
                summary("something_new", "thing", &json!({})),
                json!({"action_kind": "other", "count": 1, "examples": [], "risk": "medium",
                    "targets": [{"kind": "other", "path": "thing"}]}),
            ),
        ];
        for (actual, expected) in cases {
            assert_eq!(actual, expected);
        }
        for tool in ["project_ledger_work_complete", "complete_project_work"] {
            assert_eq!(
                summary(tool, "x", &json!({}))["action_kind"],
                "update_project",
                "{tool}"
            );
        }
        super::command_risk::pinned::assert_command_risks();
    }
}
