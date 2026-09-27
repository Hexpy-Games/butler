//! Tool candidates of the selected phase and its policy flags.

use super::*;

/// Names of the tools the provider surface offers: initial tools of the
/// always-on and required profiles, memory startup tools, required tools,
/// bridges, Work tools where Work is tracked, and the role's delegation tools.
pub(super) fn provider_candidates(
    catalog: &GuidedCatalogSnapshot,
    authorized: &[&GuidedCatalogTool],
    policy: &GuidedExecutionPolicy,
    phase: GuidedPhase,
    required_profiles: &[String],
) -> HashSet<String> {
    let mut names = profile_candidates(catalog, authorized, policy, phase, required_profiles);
    if turn_admits_zai_image_tool(policy) {
        names.insert("analyze_attached_image".to_owned());
    }
    for tool in authorized {
        if tool.name == ToolName::UpdateTodoList {
            names.insert(tool.name.clone());
        }
        if tool.category.as_deref() == Some("control")
            && tool.tags.iter().any(|tag| tag == "bridge")
        {
            names.insert(tool.name.clone());
        }
    }
    let tracked = policy.tracking_mode != "none";
    if phase == GuidedPhase::Execution || policy.subsession.is_some() && tracked {
        names.extend(
            catalog
                .tools
                .iter()
                .filter(|tool| tool.durable)
                .map(|tool| tool.name.clone()),
        );
    }
    if phase == GuidedPhase::Execution && tracked {
        names.extend(catalog.profile("workTracking").iter().cloned());
    }
    add_role_tools(&mut names, catalog, policy);
    names
}

/// Initial tools of the public-web, workspace (outside the direct phase),
/// project (when a project tool is authorized) and required profiles, the
/// startup memory tools and the required tools.
pub(super) fn profile_candidates(
    catalog: &GuidedCatalogSnapshot,
    authorized: &[&GuidedCatalogTool],
    policy: &GuidedExecutionPolicy,
    phase: GuidedPhase,
    required_profiles: &[String],
) -> HashSet<String> {
    let mut names = HashSet::new();
    let workspace = if phase == GuidedPhase::Direct {
        ""
    } else {
        "workspace"
    };
    let project = if authorized
        .iter()
        .any(|tool| tool.category.as_deref() == Some("project"))
    {
        "project"
    } else {
        ""
    };
    for profile in ["public-web", workspace, project] {
        names.extend(
            profile_initial(catalog, profile, phase)
                .iter()
                .map(|tool| tool.name.clone()),
        );
    }
    for tool in catalog.tools.iter().filter(|tool| {
        catalog.profile("startup").contains(&tool.name)
            && tool.category.as_deref() == Some("memory")
            && !tool.tags.iter().any(|tag| tag == "context")
    }) {
        names.insert(tool.name.clone());
    }
    names.extend(
        policy
            .required_tools
            .iter()
            .filter_map(|name| catalog.tool(name).map(|tool| tool.name.clone())),
    );
    for profile in required_profiles {
        names.extend(
            profile_initial(catalog, profile, phase)
                .iter()
                .map(|tool| tool.name.clone()),
        );
    }
    names
}

/// The butler delegates to stewards (and may bind a worktree with full
/// project access) and never sees non-durable project tools; a steward
/// delegates to workers.
pub(super) fn add_role_tools(
    names: &mut HashSet<String>,
    catalog: &GuidedCatalogSnapshot,
    policy: &GuidedExecutionPolicy,
) {
    if policy.role == PolicyRole::Butler {
        names.extend(["delegate_to_steward", "steer_steward", "cancel_steward"].map(str::to_owned));
        if policy.access_mode == AccessMode::FullAccess && policy.project_id.is_some() {
            names.insert("bind_session_git_worktree".into());
        }
    }
    if policy.role == PolicyRole::Steward {
        names.extend(["delegate_to_worker", "steer_worker", "wait_for_worker"].map(str::to_owned));
    }
    if policy.role == PolicyRole::Butler {
        names.retain(|name| {
            catalog
                .tool(name)
                .is_none_or(|tool| tool.category.as_deref() != Some("project") || tool.durable)
        });
    }
}

pub(super) fn phase(
    policy: &GuidedExecutionPolicy,
    catalog: &GuidedCatalogSnapshot,
) -> GuidedPhase {
    if policy.tracking_mode != "none"
        && (policy.role == PolicyRole::Butler || policy.subsession.is_some())
    {
        return GuidedPhase::Execution;
    }
    let workspace = policy
        .required_profiles
        .iter()
        .any(|profile| profile == "workspace")
        || policy.required_tools.iter().any(|name| {
            catalog
                .tool(name)
                .is_some_and(|tool| matches!(tool.category.as_deref(), Some("command" | "file")))
        });
    if !policy.has_project_id() && !workspace {
        return if policy.role == PolicyRole::Butler && policy.tracking_mode != "none" {
            GuidedPhase::Execution
        } else {
            GuidedPhase::Direct
        };
    }
    if policy.access_mode == AccessMode::ReadOnly {
        GuidedPhase::ReadOnly
    } else {
        GuidedPhase::Execution
    }
}
pub(super) fn enabled(flag: &str) -> bool {
    matches!(
        butler_core::public_text::trim_js_whitespace(flag)
            .to_lowercase()
            .as_str(),
        "1" | "true" | "on" | "yes"
    )
}
pub(super) fn ineligible_profile(
    profile: &str,
    phase: GuidedPhase,
    missing: Option<&str>,
) -> GuidedPreparationError {
    let phase = phase.as_str();
    GuidedPreparationError::Policy(match missing {
        Some(name) => {
            format!("required tool profile is ineligible for {phase} phase: {profile} ({name})")
        }
        None => format!("required tool profile is ineligible for {phase} phase: {profile}"),
    })
}
// Passthrough: tool arguments/results/schemas, shaped by each tool.
pub(super) fn without_defaults(mut value: Value) -> Value {
    // Passthrough: tool arguments/results/schemas, shaped by each tool.
    pub(super) fn clean(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.remove("default");
                for child in map.values_mut() {
                    clean(child);
                }
            }
            Value::Array(array) => {
                for child in array {
                    clean(child);
                }
            }
            _ => {}
        }
    }
    if let Some(parameters) = value.get_mut("parameters") {
        clean(parameters);
    }
    value
}
