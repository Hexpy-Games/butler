//! What a pending authority request would do, as structured data (#235):
//! the kind of action, its targets, how many, a few examples and a risk
//! level. The App composes the sentence in the user's language; nothing
//! here is display text.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use butler_core::tool_protocol::ToolName;

/// Most targets and examples one approval lists.
const MAX_TARGETS: usize = 20;
const MAX_EXAMPLES: usize = 3;
/// A command example is cut after this many characters.
const MAX_EXAMPLE_CHARS: usize = 200;
/// Command fragments that make a command high risk.
const HIGH_RISK_COMMAND_PARTS: [&str; 14] = [
    "rm -r",
    "rm -f",
    "sudo ",
    "git push",
    "--force",
    "reset --hard",
    "git clean",
    "mkfs",
    "dd if=",
    "chmod -r",
    "chown -r",
    "drop table",
    "drop database",
    "shutdown",
];

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
    /// Record project work (plans, tasks, reviews).
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
    /// A folder or file path, `server/tool` for a connector, or the
    /// operation's own target name.
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
            facts.workspace,
            ApprovalRisk::Low,
        ),
        capability => by_tool(facts, ToolName::parse(capability)),
    }
}

fn by_tool(facts: ApprovalFacts<'_>, tool: Option<ToolName>) -> AuthorityApproval {
    match tool {
        Some(ToolName::WriteFile | ToolName::EditFile) => file_edits(facts),
        Some(ToolName::DeleteAutomation) => single(
            ApprovalActionKind::ManageSchedule,
            ApprovalTargetKind::Schedule,
            facts.target,
            ApprovalRisk::High,
        ),
        Some(ToolName::CreateAutomation | ToolName::RunDueAutomations) => single(
            ApprovalActionKind::ManageSchedule,
            ApprovalTargetKind::Schedule,
            facts.target,
            ApprovalRisk::Medium,
        ),
        Some(
            ToolName::ProjectLedgerCreate
            | ToolName::ProjectLedgerUpdate
            | ToolName::ProjectLedgerWorkUpdate
            | ToolName::ProjectLedgerTaskUpdate
            | ToolName::ProjectLedgerTaskComplete
            | ToolName::ProjectLedgerAttemptSucceed
            | ToolName::ProjectLedgerAttemptFail,
        ) => single(
            ApprovalActionKind::UpdateProject,
            ApprovalTargetKind::Project,
            facts.target,
            ApprovalRisk::Low,
        ),
        _ => single(
            ApprovalActionKind::Other,
            ApprovalTargetKind::Other,
            facts.target,
            ApprovalRisk::Medium,
        ),
    }
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
            let path = relative(path, facts.workspace);
            if !path.is_empty() && !files.contains(&path) {
                files.push(path);
            }
        }
    }
    let mut targets = vec![folder(facts.workspace)];
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

/// A command: its folder (`cwd` within the workspace) and the command line.
fn command(facts: ApprovalFacts<'_>, kind: ApprovalActionKind) -> AuthorityApproval {
    let line = facts
        .input
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let cwd = facts
        .input
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or(".");
    let folder_path = if cwd == "." || cwd.is_empty() {
        facts.workspace.to_owned()
    } else {
        Path::new(facts.workspace)
            .join(cwd)
            .to_string_lossy()
            .into_owned()
    };
    let lowered = line.to_ascii_lowercase();
    let risk = if HIGH_RISK_COMMAND_PARTS
        .iter()
        .any(|part| lowered.contains(part))
    {
        ApprovalRisk::High
    } else {
        ApprovalRisk::Medium
    };
    AuthorityApproval {
        action_kind: kind,
        targets: vec![folder(&folder_path)],
        count: 1,
        examples: (!line.is_empty())
            .then(|| line.chars().take(MAX_EXAMPLE_CHARS).collect())
            .into_iter()
            .collect(),
        risk,
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

fn folder(path: &str) -> ApprovalTarget {
    ApprovalTarget {
        kind: ApprovalTargetKind::Folder,
        path: path.to_owned(),
    }
}

/// `path` relative to `workspace` when it lies inside it.
fn relative(path: &str, workspace: &str) -> String {
    Path::new(path).strip_prefix(workspace).map_or_else(
        |_| path.to_owned(),
        |inner| inner.to_string_lossy().into_owned(),
    )
}

fn saturating_count(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const WORKSPACE: &str = "/work/garden";

    fn summary(capability: &str, target: &str, input: &Value) -> AuthorityApproval {
        summarize(ApprovalFacts {
            capability,
            target,
            input,
            workspace: WORKSPACE,
        })
    }

    /// Format pin: one summary per action kind, as the App reads them.
    #[test]
    fn every_action_kind_is_summarized_without_display_text() {
        let edits = json!({"edits": [
            {"path": "/work/garden/a.txt"}, {"path": "b.txt"}, {"path": "a.txt"},
            {"path": "c.txt"}, {"path": "d.txt"}]});
        let cases = [
            (
                summary("write_file", "notes.txt", &json!({"path": "notes.txt"})),
                json!({"action_kind": "edit_files", "count": 1, "examples": ["notes.txt"], "risk": "medium",
                    "targets": [{"kind": "folder", "path": WORKSPACE}, {"kind": "file", "path": "notes.txt"}]}),
            ),
            (
                summary("edit_file", "batch", &edits),
                json!({"action_kind": "edit_files", "count": 4, "examples": ["a.txt", "b.txt", "c.txt"], "risk": "medium",
                    "targets": [{"kind": "folder", "path": WORKSPACE}, {"kind": "file", "path": "a.txt"},
                                {"kind": "file", "path": "b.txt"}, {"kind": "file", "path": "c.txt"},
                                {"kind": "file", "path": "d.txt"}]}),
            ),
            (
                summary(
                    "run_command",
                    "workspace-command:app",
                    &json!({"command": "npm test", "cwd": "app", "state_effect": "mutation"}),
                ),
                json!({"action_kind": "run_command", "count": 1, "examples": ["npm test"], "risk": "medium",
                    "targets": [{"kind": "folder", "path": "/work/garden/app"}]}),
            ),
            (
                summary(
                    "run_command",
                    "workspace-command:.",
                    &json!({"command": "rm -rf build", "cwd": ".", "state_effect": "mutation"}),
                ),
                json!({"action_kind": "run_command", "count": 1, "examples": ["rm -rf build"], "risk": "high",
                    "targets": [{"kind": "folder", "path": WORKSPACE}]}),
            ),
            (
                summary(
                    "run_command_remote_observation",
                    "remote-observation-command:.",
                    &json!({"command": "curl https://example.com", "cwd": "."}),
                ),
                json!({"action_kind": "network_command", "count": 1, "examples": ["curl https://example.com"],
                    "risk": "medium", "targets": [{"kind": "folder", "path": WORKSPACE}]}),
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
                summary("project_ledger_create", "ledger:work", &json!({})),
                json!({"action_kind": "update_project", "count": 1, "examples": [], "risk": "low",
                    "targets": [{"kind": "project", "path": "ledger:work"}]}),
            ),
            (
                summary("request_service_restart", "service", &json!({})),
                json!({"action_kind": "restart_service", "count": 1, "examples": [], "risk": "medium",
                    "targets": [{"kind": "service", "path": "butler"}]}),
            ),
            (
                summary("something_new", "thing", &json!({})),
                json!({"action_kind": "other", "count": 1, "examples": [], "risk": "medium",
                    "targets": [{"kind": "other", "path": "thing"}]}),
            ),
        ];
        for (actual, expected) in cases {
            assert_eq!(serde_json::to_value(&actual).unwrap(), expected);
        }
    }
}
