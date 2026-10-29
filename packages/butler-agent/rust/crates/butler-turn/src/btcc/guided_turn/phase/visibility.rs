mod browser;
mod names;
use names::*;
use std::collections::HashSet;

use crate::btcc::{AccessMode, ApprovalExemptAction};
use butler_core::tool_protocol::ToolName;

use super::catalog::{GuidedCatalogSnapshot, GuidedCatalogTool};
use super::policy::{GuidedExecutionPolicy, PolicyRole};
use super::selection::GuidedPhase;

/// The tools a guided turn is authorized to call on the legacy surface, from
/// its role, access mode, tracking mode and project binding.
/// What the turn context says about its project.
#[derive(Clone, Copy)]
pub(super) struct ProjectSignals {
    /// The context names a project.
    pub(super) project_ref: bool,
    /// The context carries project sources.
    pub(super) project_sources: bool,
}

pub(super) fn legacy_authorized<'a>(
    catalog: &'a GuidedCatalogSnapshot,
    policy: &GuidedExecutionPolicy,
    signals: ProjectSignals,
) -> Vec<&'a GuidedCatalogTool> {
    let scope = AuthorizationScope {
        has_project: policy.has_project_id() || signals.project_ref,
        ledger: policy.tracking_mode == "ledger",
        worker: policy.role == PolicyRole::Worker,
    };
    let mut names = if scope.worker {
        catalog.worker_default.clone()
    } else {
        catalog.profile_names(&authorized_profiles(catalog, policy, scope))
    };
    if !scope.worker && scope.has_project && policy.access_mode == AccessMode::FullAccess {
        names.insert("bind_session_git_worktree".into());
    }
    for name in &policy.required_tools {
        let trimmed = name.trim();
        if catalog.tool(trimmed).is_some()
            && !(scope.worker && catalog.worker_forbidden.contains(trimmed))
        {
            names.insert(trimmed.into());
        }
    }
    if !scope.ledger || policy.access_mode == AccessMode::ReadOnly {
        names.retain(|name| !catalog.project_mutations.contains(name));
    }
    if !scope.ledger {
        names.retain(|name| !catalog.project_inspection.contains(name));
    }
    names.extend(DISCOVERY.iter().map(|name| (*name).to_owned()));
    names.insert("output_check".into());
    authorize_schedules(&mut names, policy, scope);
    apply_access_mode(&mut names, catalog, policy, scope);
    browser::authorize(&mut names, catalog, policy, scope.worker);
    image_calls(&mut names, policy);
    names.retain(|name| {
        !catalog.project_mutations.contains(name)
            && (!catalog.work_tracking.contains(name)
                || matches!(
                    ToolName::parse(name.as_str()),
                    Some(
                        ToolName::UpdateTodoList
                            | ToolName::ListTodoList
                            | ToolName::ListWorkStreams
                            | ToolName::UpdateWorkStreamState
                    )
                ))
    });
    if policy.access_mode != AccessMode::ReadOnly && scope.ledger && scope.has_project {
        names.extend(catalog.managed_ledger_effects.iter().cloned());
    }
    if signals.project_sources {
        names.insert("read_project_source".into());
    } else {
        names.remove("read_project_source");
    }
    // Moving the working folder goes wherever commands may run.
    if names.contains("run_command") {
        names.insert("switch_folder".into());
    }
    let tracked = policy.tracking_mode != "none";
    if tracked {
        names.extend(
            catalog
                .tools
                .iter()
                .filter(|tool| tool.durable)
                .map(|tool| tool.name.clone()),
        );
    }
    apply_role(&mut names, policy);
    catalog
        .tools
        .iter()
        .filter(|tool| names.contains(&tool.name) && (!tool.durable || tracked))
        .collect()
}

fn authorize_canon(names: &mut HashSet<String>, policy: &GuidedExecutionPolicy) {
    if policy.role == PolicyRole::Butler && policy.subsession.is_none() {
        names.extend([
            "canon_read".into(),
            "canon_propose".into(),
            "canon_queue".into(),
        ]);
    } else {
        names.remove("canon_read");
        names.remove("canon_propose");
        names.remove("canon_queue");
    }
}

/// The facts of a policy that shape legacy authorization.
#[derive(Clone, Copy)]
struct AuthorizationScope {
    has_project: bool,
    /// Work is tracked in the project ledger.
    ledger: bool,
    worker: bool,
}

/// Schedules are discoverable session capabilities, not always-visible schemas.
/// Writes still use the reviewed effect owner and ask-first authority at dispatch.
fn authorize_schedules(
    names: &mut HashSet<String>,
    policy: &GuidedExecutionPolicy,
    scope: AuthorizationScope,
) {
    if scope.worker {
        return;
    }
    names.insert("list_automations".into());
    if policy.role == PolicyRole::Butler && policy.access_mode != AccessMode::ReadOnly {
        names.extend(SCHEDULE_WRITES.iter().map(|name| (*name).to_owned()));
    }
}

/// The catalog profiles a non-worker turn draws its tools from.
fn authorized_profiles(
    catalog: &GuidedCatalogSnapshot,
    policy: &GuidedExecutionPolicy,
    scope: AuthorizationScope,
) -> Vec<String> {
    let mut profiles = if scope.worker {
        Vec::new()
    } else {
        vec!["startup".to_owned()]
    };
    if !scope.worker && scope.ledger && scope.has_project {
        profiles.push("project".into());
        if policy.access_mode != AccessMode::ReadOnly {
            profiles.push("project-lifecycle".into());
        }
    }
    profiles.extend(
        policy
            .required_profiles
            .iter()
            .map(|name| butler_core::public_text::trim_js_whitespace(name))
            .filter(|name| catalog.profiles.contains_key(*name))
            .map(str::to_owned),
    );
    profiles.extend(["public-web".into(), "memory-read".into()]);
    if policy.tracking_mode != "none" {
        profiles.push("workTracking".into());
    }
    if policy.access_mode == AccessMode::FullAccess {
        profiles.push("workspace".into());
    }
    if scope.has_project {
        profiles.push("project".into());
    }
    if !scope.worker && !scope.ledger {
        profiles.retain(|name| name != "project" && name != "project-lifecycle");
    }
    if !scope.worker && !scope.ledger || policy.access_mode == AccessMode::ReadOnly {
        profiles.retain(|name| name != "project-lifecycle");
    }
    profiles
}

/// Full access adds effect-free tools, commands, file writes and MCP calls.
/// Ask-first keeps the non-full allowlist with commands, file writes and MCP
/// calls (each asks before it runs) and the required tools of its
/// approval-free actions. Read-only keeps only the non-full allowlist, without
/// its writes (`ASK_FIRST_WRITES`).
fn apply_access_mode(
    names: &mut HashSet<String>,
    catalog: &GuidedCatalogSnapshot,
    policy: &GuidedExecutionPolicy,
    scope: AuthorizationScope,
) {
    if policy.access_mode == AccessMode::FullAccess {
        for tool in &catalog.tools {
            if !tool.durable
                && tool.effect_boundary.as_deref() == Some("none")
                && tool.category.as_deref() != Some("project")
            {
                names.insert(tool.name.clone());
            }
        }
        names.extend(
            [
                "run_command",
                "write_file",
                "edit_file",
                "output_publish",
                "deliver_files",
            ]
            .map(str::to_owned),
        );
        if scope.has_project {
            names.insert("bind_session_git_worktree".into());
        }
        names.insert("call_mcp_tool".into());
        return;
    }
    let ask_first = policy.access_mode.reviews_effects();
    if ask_first {
        names.extend(
            [
                "run_command",
                "write_file",
                "edit_file",
                "read_tool_output_artifact",
                "call_mcp_tool",
            ]
            .map(str::to_owned),
        );
    }
    names.retain(|name| {
        NON_FULL.contains(&name.as_str())
            && (!ASK_FIRST_WRITES.contains(&name.as_str()) || ask_first)
            || ask_first && name == ToolName::CallMcpTool
            || policy.required_tools.contains(name) && policy.access_mode.exempts_tool(name)
    });
}

/// Only the butler may delegate to stewards and only a steward to workers.
/// Stewards and workers report to their parent instead of answering the
/// user, so they never show answer blocks: a child's blocks would be accepted
/// but never reach the conversation.
fn apply_role(names: &mut HashSet<String>, policy: &GuidedExecutionPolicy) {
    authorize_canon(names, policy);
    if matches!(policy.role, PolicyRole::Steward | PolicyRole::Worker) {
        names.remove("answer_blocks");
        names.remove("resolve_ask");
    }
    for (role, tools) in [("butler", STEWARD_PARENT), ("steward", WORKER_DELEGATION)] {
        if policy.role.as_str() == role {
            names.extend(tools.iter().map(|name| (*name).to_owned()));
        } else {
            for name in tools {
                names.remove(*name);
            }
        }
    }
}

/// Workspace write tools every non-read-only tier offers.
const WRITE_TOOLS: [&str; 4] = [
    "run_command",
    "read_tool_output_artifact",
    "write_file",
    "edit_file",
];

pub(super) fn legacy_visible<'a>(
    authorized: &[&'a GuidedCatalogTool],
    policy: &GuidedExecutionPolicy,
) -> Vec<&'a GuidedCatalogTool> {
    let project = policy.tracking_mode == "ledger" && policy.has_project_id();
    let mut names: HashSet<&str> = LEGACY_BASE.into_iter().collect();
    names.extend(
        authorized
            .iter()
            .filter(|tool| tool.durable)
            .map(|tool| tool.name.as_str()),
    );
    if project {
        names.insert("project_ledger_list");
    }
    if project && policy.access_mode != AccessMode::ReadOnly {
        names.insert("project_ledger_create");
    }
    if policy.role == PolicyRole::Butler {
        names.extend(["canon_read", "canon_propose", "canon_queue"]);
        names.extend(STEWARD_PARENT.iter().copied());
    }
    if policy.role == PolicyRole::Steward {
        names.extend(WORKER_DELEGATION.iter().copied());
    }
    if policy.tracking_mode != "none" {
        names.extend([
            "update_todo_list",
            "list_todo_list",
            "list_work_streams",
            "update_work_stream_state",
        ]);
    }
    match policy.access_mode {
        AccessMode::ReadOnly => {}
        AccessMode::AskAlways | AccessMode::AskExceptReads | AccessMode::Auto => {
            names.extend(WRITE_TOOLS);
            names.extend(
                policy
                    .required_tools
                    .iter()
                    .map(String::as_str)
                    .filter(|name| policy.access_mode.exempts_tool(name)),
            );
        }
        AccessMode::FullAccess => {
            names.extend(WRITE_TOOLS);
            names.extend(policy.required_tools.iter().map(String::as_str));
            if policy.has_project_id() {
                names.insert("bind_session_git_worktree");
            }
            if authorized
                .iter()
                .any(|tool| tool.name == ToolName::AnalyzeAttachedImage)
            {
                names.insert("analyze_attached_image");
            }
        }
    }
    names.extend(["generate_image", "edit_image"]);
    if names.contains("run_command") {
        names.insert("switch_folder");
    }
    authorized
        .iter()
        .copied()
        .filter(|tool| names.contains(tool.name.as_str()))
        .collect()
}

pub(super) fn phase_allows(phase: GuidedPhase, tool: &GuidedCatalogTool) -> bool {
    if matches!(
        tool.name.as_str(),
        "canon_read" | "canon_propose" | "canon_queue"
    ) {
        return true;
    }
    if phase == GuidedPhase::Execution {
        return true;
    }
    if tool.durable {
        return false;
    }
    if matches!(tool.name.as_str(), "generate_image" | "edit_image") {
        return true;
    }
    if matches!(
        tool.name.as_str(),
        "browser_act"
            | "browser_wait_for_user"
            | "browser_sign_in"
            | "browser_pay_fill"
            | "browser_autofill_fill"
    ) {
        return true;
    }
    if tool.effect_boundary.as_deref() == Some("turn_local")
        && tool.category.as_deref() == Some("message")
    {
        return true;
    }
    if tool.effect_boundary.as_deref() != Some("none") {
        return false;
    }
    phase != GuidedPhase::Direct
        || tool.name == ToolName::ProjectArtifacts
        || !matches!(
            tool.category.as_deref(),
            Some("project" | "command" | "file" | "work")
        )
}

pub(super) fn profile_initial<'a>(
    catalog: &'a GuidedCatalogSnapshot,
    profile: &str,
    phase: GuidedPhase,
) -> Vec<&'a GuidedCatalogTool> {
    if profile == "project-lifecycle" {
        return vec![];
    }
    let names: HashSet<_> = catalog.profile(profile).iter().collect();
    let tools: Vec<_> = catalog
        .tools
        .iter()
        .filter(|tool| names.contains(&tool.name) && phase_allows(phase, tool))
        .collect();
    if profile == "project" {
        return tools
            .into_iter()
            .filter(|tool| tool.effect_boundary.as_deref() == Some("none"))
            .take(1)
            .collect();
    }
    if profile == "workspace" {
        return tools
            .into_iter()
            .filter(|tool| matches!(tool.category.as_deref(), Some("command" | "file")))
            .collect();
    }
    tools
}

/// The host names the image tool as required only for a turn whose attached
/// image it admitted; ask-first analyzes that image without asking.
pub(super) fn turn_admits_zai_image_tool(policy: &GuidedExecutionPolicy) -> bool {
    policy
        .access_mode
        .allows_without_approval(ApprovalExemptAction::AttachedImageAnalysis)
        && policy
            .required_tools
            .iter()
            .any(|name| name == ToolName::AnalyzeAttachedImage)
}

fn image_calls(names: &mut HashSet<String>, policy: &GuidedExecutionPolicy) {
    if policy.role == PolicyRole::Butler
        && policy.subsession.is_none()
        && policy.access_mode != AccessMode::ReadOnly
    {
        names.extend(["generate_image".into(), "edit_image".into()]);
    } else {
        names.remove("generate_image");
        names.remove("edit_image");
    }
}
