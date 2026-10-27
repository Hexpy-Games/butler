//! What a pending authority request would do, as structured data (#235):
//! the kind of action, its targets, how many, a few examples and a risk
//! level. The App composes the sentence in the user's language. Legacy
//! summaries use workspace labels; the local decision projection also carries
//! exact operation paths, without tool contents or credentials.

mod canon;
mod command_risk;
mod operation;
mod schedule;
mod tool;
pub(super) use operation::exact_operation;
pub(super) use schedule::{schedule, schedule_update};

use std::collections::HashSet;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use butler_core::tool_protocol::ToolName;
pub(in crate::btcc) use command_risk::command_risk;

/// Most examples one approval lists; all targets remain visible.
const MAX_EXAMPLES: usize = 3;
/// Safety cap per example, measured in UTF-8 bytes.
const MAX_EXAMPLE_BYTES: usize = 16 * 1024;
/// A folder label is cut after this many characters.
const MAX_LABEL_CHARS: usize = 80;
/// The label of a workspace whose folder has no usable name.
const FALLBACK_LABEL: &str = "workspace";

/// The structured summary of a pending request (`approval` in its JSON).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorityApproval {
    /// Exact decision facts for the local approval UI, never raw tool payloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<operation::ApprovalOperation>,
    pub action_kind: ApprovalActionKind,
    /// What the action touches, the folder first where there is one.
    pub targets: Vec<ApprovalTarget>,
    /// How many items (files, commands, calls) the action covers.
    pub count: u32,
    /// Up to three concrete items: file paths or the command line.
    pub examples: Vec<String>,
    /// One flag per example; old stored approvals default to no flags.
    #[serde(default, skip_serializing_if = "no_truncation")]
    pub examples_truncated: Vec<bool>,
    pub risk: ApprovalRisk,
    /// Declared observation intent; OS isolation is unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_access: Option<String>,
    /// What a reviewed schedule create sets up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<schedule::ApprovalSchedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canon: Option<canon::ApprovalCanon>,
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
    /// A web URL or search query carrying outside content.
    WebRequest,
    /// Call a tool of a connected MCP server.
    UseConnector,
    GenerateImage,
    EditImage,
    /// Create, delete or run schedules.
    ManageSchedule,
    /// Record project work (plans, tasks, attempts, reviews).
    UpdateProject,
    CreateCanon,
    /// Start a conversation on a topic.
    StartConversation,
    /// Restart the Butler service.
    RestartService,
    /// Give the conversation its own Git worktree.
    CreateWorktree,
    /// Move the conversation's working folder outside its current folder.
    SwitchFolder,
    /// Any other reviewed operation.
    Other,
}

/// One thing an action touches.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalTarget {
    pub kind: ApprovalTargetKind,
    /// A folder label (`garden`, `garden/app`), a path inside the
    /// workspace, an exact absolute path, `server/tool` for a connector,
    /// or the operation's own target name.
    pub path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalTargetKind {
    Folder,
    File,
    /// A target outside the workspace; path retains the exact requested path.
    Outside,
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
        "run_command" | "preview_start" => command(facts, ApprovalActionKind::RunCommand),
        "run_command_remote_observation" => command(facts, ApprovalActionKind::NetworkCommand),
        "web_read" | "web_search" => single(
            ApprovalActionKind::WebRequest,
            ApprovalTargetKind::Other,
            facts.target,
            ApprovalRisk::High,
        ),
        "generate_image" | "edit_image" => single(
            if facts.capability == "generate_image" {
                ApprovalActionKind::GenerateImage
            } else {
                ApprovalActionKind::EditImage
            },
            ApprovalTargetKind::Other,
            facts.target,
            ApprovalRisk::High,
        ),
        "call_mcp_tool" => mcp(facts),
        "canon_propose" => canon::summarize(facts),
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
        "switch_folder" => single(
            ApprovalActionKind::SwitchFolder,
            ApprovalTargetKind::Outside,
            facts.target.strip_prefix("folder:").unwrap_or(facts.target),
            ApprovalRisk::Medium,
        ),
        "browser_act" | "browser_close" => single(
            ApprovalActionKind::Other,
            ApprovalTargetKind::Other,
            facts.target,
            if facts.input["always_confirm"] == true {
                ApprovalRisk::High
            } else {
                ApprovalRisk::Medium
            },
        ),
        capability => tool::by_tool(facts, ToolName::parse(capability)),
    }
}

fn mcp(facts: ApprovalFacts<'_>) -> AuthorityApproval {
    let mut approval = single(
        ApprovalActionKind::UseConnector,
        ApprovalTargetKind::Connector,
        facts.target.strip_prefix("mcp:").unwrap_or(facts.target),
        ApprovalRisk::High,
    );
    if let Some(arguments) = facts
        .input
        .get("arguments")
        .and_then(Value::as_object)
        .filter(|a| !a.is_empty())
    {
        // Show the exact operation's arguments, independent of any connector or tool vocabulary.
        approval
            .examples
            .push(butler_core::public_text::sanitize_public_delta(
                &Value::Object(arguments.clone()).to_string(),
            ));
    }
    approval
}

/// `write_file` (`path`) or `edit_file` (`path`, or `edits[].path`): the
/// folder, then each distinct file.
fn file_edits(facts: ApprovalFacts<'_>) -> AuthorityApproval {
    let mut files = Vec::new();
    let mut identities = HashSet::new();
    let entries = match facts.input.get("edits").and_then(Value::as_array) {
        Some(edits) => edits.iter().collect(),
        None => vec![facts.input],
    };
    for entry in entries {
        if let Some(path) = entry.get("path").and_then(Value::as_str) {
            let relative = inside_workspace(path, facts.workspace);
            let identity = relative.clone().unwrap_or_else(|| path.to_owned());
            if !identity.is_empty() && identities.insert(identity) {
                files.push(ApprovalTarget {
                    kind: if relative.is_some() {
                        ApprovalTargetKind::File
                    } else {
                        ApprovalTargetKind::Outside
                    },
                    path: relative.unwrap_or_else(|| absolute_target(path, facts.workspace)),
                });
            }
        }
    }
    let outside = files
        .iter()
        .any(|file| file.kind == ApprovalTargetKind::Outside);
    let count = saturating_count(files.len());
    let (examples, examples_truncated) = files
        .iter()
        .take(MAX_EXAMPLES)
        .map(|file| cap_example(&file.path))
        .unzip();
    let mut targets = vec![folder(workspace_label(facts.workspace))];
    targets.extend(files);
    AuthorityApproval {
        operation: None,
        schedule: None,
        canon: None,
        command_access: None,
        action_kind: ApprovalActionKind::EditFiles,
        targets,
        count,
        examples,
        examples_truncated,
        risk: if outside {
            ApprovalRisk::High
        } else {
            ApprovalRisk::Medium
        },
    }
}

/// Exact observation paths are shown before reading, including paths outside the workspace.
fn file_reads(facts: ApprovalFacts<'_>) -> AuthorityApproval {
    let paths: Vec<String> = if let Some(requests) = facts.input["requests"].as_array() {
        requests
            .iter()
            .filter_map(|r| r["path"].as_str().map(str::to_owned))
            .collect()
    } else {
        vec![facts.input["root"].as_str().unwrap_or(".").to_owned()]
    };
    AuthorityApproval {
        operation: None,
        action_kind: ApprovalActionKind::Other,
        targets: paths
            .iter()
            .map(|path| ApprovalTarget {
                kind: if facts.capability == "read_file" {
                    ApprovalTargetKind::File
                } else {
                    ApprovalTargetKind::Folder
                },
                path: path.clone(),
            })
            .collect(),
        count: saturating_count(paths.len()),
        examples_truncated: vec![false; paths.len()],
        examples: paths,
        risk: ApprovalRisk::Low,
        schedule: None,
        canon: None,
        command_access: None,
    }
}

/// A command: its folder (the workspace label, plus `cwd` inside it) and
/// the command line.
fn command(facts: ApprovalFacts<'_>, kind: ApprovalActionKind) -> AuthorityApproval {
    let line = facts
        .input
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let label = workspace_label(facts.workspace);
    let cwd = facts
        .input
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let target = match inside_workspace(cwd, facts.workspace) {
        Some(relative) => folder(if relative.is_empty() {
            label
        } else {
            format!("{label}/{relative}")
        }),
        None => ApprovalTarget {
            kind: ApprovalTargetKind::Outside,
            path: absolute_target(cwd, facts.workspace),
        },
    };
    let risk = if target.kind == ApprovalTargetKind::Outside {
        ApprovalRisk::High
    } else {
        command_risk(line)
    };
    let (examples, examples_truncated) = (!line.is_empty())
        .then(|| cap_example(line))
        .into_iter()
        .unzip();
    AuthorityApproval {
        operation: None,
        schedule: None,
        canon: None,
        command_access: (!butler_platform::command_sandbox::approval_free_reads()
            && matches!(
                facts.input.get("state_effect").and_then(Value::as_str),
                Some("read_only" | "validation")
            ))
        .then(|| "read_only_unisolated".into()),
        action_kind: kind,
        targets: vec![target],
        count: 1,
        examples,
        examples_truncated,
        risk,
    }
}

fn no_truncation(flags: &[bool]) -> bool {
    !flags.iter().any(|flag| *flag)
}

fn cap_example(text: &str) -> (String, bool) {
    let mut end = text.len().min(MAX_EXAMPLE_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), end < text.len())
}

fn single(
    action_kind: ApprovalActionKind,
    kind: ApprovalTargetKind,
    path: &str,
    risk: ApprovalRisk,
) -> AuthorityApproval {
    AuthorityApproval {
        operation: None,
        schedule: None,
        canon: None,
        command_access: None,
        action_kind,
        targets: vec![ApprovalTarget {
            kind,
            path: path.to_owned(),
        }],
        count: 1,
        examples: Vec::new(),
        examples_truncated: Vec::new(),
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
    if Path::new(workspace)
        .file_name()
        .is_some_and(|name| name == ".butler")
    {
        return workspace.to_owned();
    }
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
/// that is absolute outside the workspace, or climbs out of it, returns None.
fn inside_workspace(path: &str, workspace: &str) -> Option<String> {
    let path = Path::new(path);
    // Persisted approval paths may use a rooted spelling without this host's drive prefix.
    let relative = if path.has_root() {
        match path.strip_prefix(workspace) {
            Ok(inner) => inner,
            Err(_) => return None,
        }
    } else {
        path
    };
    let mut parts: Vec<String> = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::ParentDir => {
                parts.pop()?;
            }
            _ => {}
        }
    }
    Some(parts.join("/"))
}

/// The real target outside the workspace, as file tools resolve and check it.
fn absolute_target(path: &str, workspace: &str) -> String {
    butler_platform::tool_paths::resolve(Path::new(workspace), path).map_or_else(
        |_| path.to_owned(),
        |target| target.to_string_lossy().into_owned(),
    )
}

fn saturating_count(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

#[cfg(test)]
pub(super) mod pinned;
