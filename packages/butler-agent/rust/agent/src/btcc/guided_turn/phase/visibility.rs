use std::collections::HashSet;

use crate::btcc::AccessMode;

use super::catalog::{GuidedCatalogSnapshot, GuidedCatalogTool};
use super::policy::GuidedExecutionPolicy;

mod image_admission;
pub(super) use image_admission::turn_admits_zai_image_tool;

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
    "read_mcp_resource",
    "list_skills",
    "transform_public_data_table",
];
const STEWARD_PARENT: &[&str] = &["delegate_to_steward", "steer_steward", "cancel_steward"];
const WORKER_DELEGATION: &[&str] = &["delegate_to_worker", "steer_worker", "wait_for_worker"];
pub(super) fn legacy_authorized<'a>(
    catalog: &'a GuidedCatalogSnapshot,
    policy: &GuidedExecutionPolicy,
    project_ref: bool,
    project_sources: bool,
) -> Vec<&'a GuidedCatalogTool> {
    let has_project = policy.has_project_id() || project_ref;
    let ledger = policy.tracking_mode == "ledger";
    let mut profiles = if policy.role == "worker" {
        Vec::new()
    } else {
        vec!["startup".to_owned()]
    };
    if policy.role != "worker" && ledger && has_project {
        profiles.push("project".into());
        if policy.access_mode != AccessMode::ReadOnly {
            profiles.push("project-lifecycle".into());
        }
    }
    profiles.extend(
        policy
            .required_profiles
            .iter()
            .map(|name| crate::public_text::trim_js_whitespace(name))
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
    if has_project {
        profiles.push("project".into());
    }
    if policy.role != "worker" && !ledger {
        profiles.retain(|name| name != "project" && name != "project-lifecycle");
    }
    if policy.role != "worker" && !ledger || policy.access_mode == AccessMode::ReadOnly {
        profiles.retain(|name| name != "project-lifecycle");
    }
    let mut names = if policy.role == "worker" {
        catalog.worker_default.clone()
    } else {
        catalog.profile_names(&profiles)
    };
    if policy.role != "worker" && has_project && policy.access_mode == AccessMode::FullAccess {
        names.insert("bind_session_git_worktree".into());
    }
    for name in &policy.required_tools {
        let trimmed = name.trim();
        if catalog.tool(trimmed).is_some()
            && !(policy.role == "worker" && catalog.worker_forbidden.contains(trimmed))
        {
            names.insert(trimmed.into());
        }
    }
    if !ledger || policy.access_mode == AccessMode::ReadOnly {
        names.retain(|name| !catalog.project_mutations.contains(name));
    }
    if !ledger {
        names.retain(|name| !catalog.project_inspection.contains(name));
    }
    names.extend(DISCOVERY.iter().map(|name| (*name).to_owned()));
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
        if has_project {
            names.insert("bind_session_git_worktree".into());
        }
    } else {
        if policy.access_mode == AccessMode::AskFirst {
            names.extend(
                [
                    "run_command",
                    "write_file",
                    "edit_file",
                    "read_tool_output_artifact",
                ]
                .map(str::to_owned),
            );
        }
        names.retain(|name| {
            NON_FULL.contains(&name.as_str())
                && (name != "run_command" || policy.access_mode == AccessMode::AskFirst)
        });
    }
    if policy.access_mode == AccessMode::FullAccess {
        names.insert("call_mcp_tool".into());
    } else {
        names.remove("call_mcp_tool");
    }
    if policy.role == "butler" {
        names.extend(STEWARD_PARENT.iter().map(|name| (*name).to_owned()));
    } else {
        for name in STEWARD_PARENT {
            names.remove(*name);
        }
    }
    if policy.role == "steward" {
        names.extend(WORKER_DELEGATION.iter().map(|name| (*name).to_owned()));
    } else {
        for name in WORKER_DELEGATION {
            names.remove(*name);
        }
    }
    names.retain(|name| {
        !catalog.project_mutations.contains(name)
            && (!catalog.work_tracking.contains(name)
                || matches!(
                    name.as_str(),
                    "update_todo_list"
                        | "list_todo_list"
                        | "list_work_streams"
                        | "update_work_stream_state"
                ))
    });
    if policy.access_mode != AccessMode::ReadOnly && ledger && has_project {
        names.extend(catalog.managed_ledger_effects.iter().cloned());
    }
    if project_sources {
        names.insert("read_project_source".into());
    } else {
        names.remove("read_project_source");
    }
    if policy.tracking_mode != "none" {
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
        .filter(|tool| {
            names.contains(&tool.name) && (!tool.durable || policy.tracking_mode != "none")
        })
        .collect()
}

pub(super) fn legacy_visible<'a>(
    authorized: &[&'a GuidedCatalogTool],
    policy: &GuidedExecutionPolicy,
) -> Vec<&'a GuidedCatalogTool> {
    let project = policy.tracking_mode == "ledger" && policy.has_project_id();
    let mut names: HashSet<&str> = [
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
    ]
    .into_iter()
    .collect();
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
    if policy.role == "butler" {
        names.extend(STEWARD_PARENT.iter().copied());
    }
    if policy.role == "steward" {
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
        AccessMode::AskFirst => names.extend([
            "run_command",
            "read_tool_output_artifact",
            "write_file",
            "edit_file",
        ]),
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
                .any(|tool| tool.name == "analyze_attached_image")
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

pub(super) fn phase_allows(phase: &str, tool: &GuidedCatalogTool) -> bool {
    if phase == "execution" {
        return true;
    }
    if tool.durable {
        return false;
    }
    if tool.effect_boundary.as_deref() != Some("none") {
        return false;
    }
    phase != "direct"
        || !matches!(
            tool.category.as_deref(),
            Some("project" | "command" | "file" | "work")
        )
}

pub(super) fn profile_initial<'a>(
    catalog: &'a GuidedCatalogSnapshot,
    profile: &str,
    phase: &str,
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
