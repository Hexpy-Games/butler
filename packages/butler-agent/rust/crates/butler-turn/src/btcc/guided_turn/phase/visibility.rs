use std::collections::HashSet;

use crate::btcc::{AccessMode, ApprovalExemptAction};
use butler_core::tool_protocol::ToolName;

use super::catalog::{GuidedCatalogSnapshot, GuidedCatalogTool};
use super::policy::{GuidedExecutionPolicy, PolicyRole};
use super::selection::GuidedPhase;

const DISCOVERY: &[&str] = &[
    "tool_search",
    "tool_describe",
    "tool_call",
    "web_search",
    "web_read",
    "read_file",
    "grep_files",
    "list_files",
];
const NON_FULL: &[&str] = &[
    "run_command",
    "write_file",
    "edit_file",
    "list_tool_capabilities",
    "tool_search",
    "tool_describe",
    "tool_call",
    "web_search",
    "web_read",
    "read_file",
    "read_project_source",
    "grep_files",
    "list_files",
    "read_tool_evidence_artifact",
    "read_tool_output_artifact",
    "project_ledger_status",
    "project_ledger_list",
    "project_ledger_show",
    "project_ledger_check",
    "inspect_project_status",
    "query_project_work",
    "render_project_dashboard",
    "get_work_dashboard",
    "get_context_monitor",
    "get_usage_monitor",
    "get_memory_health",
    "list_todo_list",
    "read_conversation_context",
    "list_conversation_sessions",
    "read_conversation_session",
    "recall_memory",
    "query_memory",
    "list_automations",
    "create_automation",
    "update_automation",
    "delete_automation",
    "list_wallpapers",
    "set_wallpaper",
    "save_wallpaper_module",
    "read_mcp_resource",
    "list_skills",
    "load_skill",
    "read_skill_file",
    "transform_public_data_table",
];
/// Non-full tools that change something: offered when asking first, where
/// each asks for approval before it runs (the wallpaper writes are reviewed
/// persistent effects there), and never to a read-only turn.
const SCHEDULE_WRITES: &[&str] = &[
    "create_automation",
    "update_automation",
    "delete_automation",
];
const ASK_FIRST_WRITES: &[&str] = &[
    "run_command",
    "set_wallpaper",
    "save_wallpaper_module",
    "create_automation",
    "update_automation",
    "delete_automation",
];
const STEWARD_PARENT: &[&str] = &["delegate_to_steward", "steer_steward", "cancel_steward"];
const WORKER_DELEGATION: &[&str] = &["delegate_to_worker", "steer_worker", "wait_for_worker"];
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
    authorize_schedules(&mut names, policy, scope);
    apply_access_mode(&mut names, catalog, policy, scope);
    apply_role(&mut names, policy);
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
    catalog
        .tools
        .iter()
        .filter(|tool| names.contains(&tool.name) && (!tool.durable || tracked))
        .collect()
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
    if policy.access_mode != AccessMode::ReadOnly {
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
        names.extend(["run_command", "write_file", "edit_file"].map(str::to_owned));
        if scope.has_project {
            names.insert("bind_session_git_worktree".into());
        }
        names.insert("call_mcp_tool".into());
        return;
    }
    let ask_first = policy.access_mode == AccessMode::AskFirst;
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
fn apply_role(names: &mut HashSet<String>, policy: &GuidedExecutionPolicy) {
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

/// Tools every legacy surface shows.
const LEGACY_BASE: [&str; 18] = [
    "tool_search",
    "tool_describe",
    "tool_call",
    "web_search",
    "web_read",
    "read_file",
    "grep_files",
    "list_files",
    "recall_memory",
    "query_memory",
    "list_conversation_sessions",
    "read_conversation_session",
    "read_project_source",
    "project_ledger_status",
    "update_todo_list",
    "list_todo_list",
    "load_skill",
    "read_skill_file",
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
        AccessMode::AskFirst => {
            names.extend([
                "run_command",
                "read_tool_output_artifact",
                "write_file",
                "edit_file",
            ]);
            names.extend(
                policy
                    .required_tools
                    .iter()
                    .map(String::as_str)
                    .filter(|name| policy.access_mode.exempts_tool(name)),
            );
        }
        AccessMode::FullAccess => {
            names.extend([
                "run_command",
                "read_tool_output_artifact",
                "write_file",
                "edit_file",
            ]);
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
    authorized
        .iter()
        .copied()
        .filter(|tool| names.contains(tool.name.as_str()))
        .collect()
}

pub(super) fn phase_allows(phase: GuidedPhase, tool: &GuidedCatalogTool) -> bool {
    if phase == GuidedPhase::Execution {
        return true;
    }
    if tool.durable {
        return false;
    }
    if tool.effect_boundary.as_deref() != Some("none") {
        return false;
    }
    phase != GuidedPhase::Direct
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
