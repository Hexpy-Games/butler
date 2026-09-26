use std::collections::HashSet;

use serde_json::{Value, json};

use crate::btcc::{AccessMode, TurnRecord};

use super::super::work::GuidedPreparationError;
use super::catalog::{GuidedCatalogSnapshot, GuidedCatalogTool};
use super::instructions;
use super::policy::GuidedExecutionPolicy;
use super::visibility::{
    legacy_authorized, legacy_visible, phase_allows, profile_initial, turn_admits_zai_image_tool,
};

const REVISION: &str = "butler.btcc-tool-instruction-policy.v2";

pub(crate) struct GuidedPhaseInput<'a> {
    pub(crate) turn: &'a TurnRecord,
    pub(crate) catalog: &'a GuidedCatalogSnapshot,
    pub(crate) phase_surface_flag: &'a str,
    pub(crate) operation_replay_flag: &'a str,
    pub(crate) default_workspace: &'a str,
}

#[derive(Debug)]
pub(crate) struct GuidedPhaseSelection {
    #[cfg(test)]
    pub(crate) mode: &'static str,
    pub(crate) phase: &'static str,
    pub(crate) execution_policy: GuidedExecutionPolicy,
    pub(crate) authorized_names: Vec<String>,
    pub(crate) provider_tools: Vec<Value>,
    pub(crate) stable_instruction_prefix: String,
    pub(crate) stable_provider_cache_prefix: Option<Value>,
    pub(crate) replay_mode: &'static str,
}

pub(crate) fn select_phase(
    input: GuidedPhaseInput<'_>,
) -> Result<GuidedPhaseSelection, GuidedPreparationError> {
    let policy = GuidedExecutionPolicy::from_turn(input.turn, input.default_workspace)?;
    let project_ref = input
        .turn
        .context
        .get("projectRef")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let project_sources = input
        .turn
        .context
        .get("projectSources")
        .and_then(Value::as_array)
        .is_some_and(|value| !value.is_empty());
    let catalog = input.catalog;
    let image_tool_admitted = turn_admits_zai_image_tool(&policy);
    let mut authorized = legacy_authorized(catalog, &policy, project_ref, project_sources);
    authorized.retain(|tool| tool.name != "analyze_attached_image" || image_tool_admitted);
    // Current source exact-read capability is always available, independently of replay replacement.
    for name in ["read_operation_results", "list_operation_results"] {
        if !authorized.iter().any(|tool| tool.name == name)
            && let Some(tool) = catalog.tool(name)
        {
            authorized.push(tool);
        }
    }
    let phase = phase(&policy, catalog);
    let replay_mode = if enabled(input.operation_replay_flag) {
        "available"
    } else {
        "disabled"
    };
    if !enabled(input.phase_surface_flag) {
        let mut provider = legacy_visible(&authorized, &policy);
        for name in ["read_operation_results", "list_operation_results"] {
            if !provider.iter().any(|tool| tool.name == name)
                && let Some(tool) = catalog.tool(name)
            {
                provider.push(tool);
            }
        }
        return Ok(GuidedPhaseSelection {
            #[cfg(test)]
            mode: "legacy",
            phase,
            execution_policy: policy.clone(),
            authorized_names: authorized.iter().map(|tool| tool.name.clone()).collect(),
            provider_tools: provider
                .iter()
                .map(|tool| tool.definition.clone())
                .collect(),
            stable_instruction_prefix: instructions::prefix("legacy", phase, &policy)?,
            stable_provider_cache_prefix: None,
            replay_mode,
        });
    }
    for profile in &policy.required_profiles {
        let name = crate::public_text::trim_js_whitespace(profile);
        if !name.is_empty() && !catalog.profiles.contains_key(name) {
            return Err(GuidedPreparationError::Policy(format!(
                "unknown required tool profile: {name}"
            )));
        }
    }
    let required_profiles: Vec<_> = policy
        .required_profiles
        .iter()
        .filter(|profile| {
            policy.role != "butler" || !matches!(profile.as_str(), "project" | "project-lifecycle")
        })
        .cloned()
        .collect();
    if phase != "execution" {
        for profile in &required_profiles {
            if profile == "project" {
                continue;
            }
            let effect = catalog.profile(profile).iter().any(|name| {
                catalog
                    .tool(name)
                    .is_some_and(|tool| tool.effect_boundary.as_deref() != Some("none"))
            });
            if effect {
                return Err(ineligible_profile(profile, phase, None));
            }
        }
    }
    let base_names: HashSet<_> = authorized.iter().map(|tool| tool.name.as_str()).collect();
    let admitted_profiles: Vec<_> = catalog
        .tools
        .iter()
        .filter(|tool| {
            required_profiles
                .iter()
                .any(|profile| catalog.profile(profile).contains(&tool.name))
                && (policy.access_mode == AccessMode::FullAccess
                    || base_names.contains(tool.name.as_str()))
        })
        .collect();
    for tool in admitted_profiles {
        if !authorized.iter().any(|item| item.name == tool.name) {
            authorized.push(tool);
        }
    }
    for name in if policy.role == "butler" {
        &["delegate_to_steward", "steer_steward", "cancel_steward"][..]
    } else if policy.role == "steward" {
        &["delegate_to_worker", "steer_worker", "wait_for_worker"][..]
    } else {
        &[][..]
    } {
        if let Some(tool) = catalog.tool(name)
            && !authorized.iter().any(|item| item.name == tool.name)
        {
            authorized.push(tool);
        }
    }
    // Source Map insertion order is first occurrence, even when a later value replaces it.
    authorized.retain(|tool| {
        (tool.durable && policy.subsession.is_some() && policy.tracking_mode != "none"
            || phase_allows(phase, tool))
            && (tool.name != "analyze_attached_image" || image_tool_admitted)
    });
    for name in &policy.required_tools {
        if !authorized.iter().any(|tool| &tool.name == name) {
            return Err(GuidedPreparationError::Policy(format!(
                "required tool is ineligible for {phase} phase: {name}"
            )));
        }
    }
    let provider_names = provider_candidates(
        catalog,
        &authorized,
        &policy,
        phase,
        &required_profiles,
        image_tool_admitted,
    );
    let provider: Vec<_> = authorized
        .iter()
        .filter(|tool| {
            provider_names.contains(tool.name.as_str())
                || matches!(
                    tool.name.as_str(),
                    "read_operation_results" | "list_operation_results"
                )
        })
        .copied()
        .collect();
    for name in &policy.required_tools {
        if !provider.iter().any(|tool| &tool.name == name) {
            return Err(GuidedPreparationError::Policy(format!(
                "required tool is ineligible for {phase} phase: {name}"
            )));
        }
    }
    for profile in &required_profiles {
        if profile == "project-lifecycle" {
            if phase != "execution"
                || catalog
                    .all_ledger_effects
                    .iter()
                    .any(|name| !authorized.iter().any(|tool| &tool.name == name))
            {
                return Err(ineligible_profile(profile, phase, None));
            }
            continue;
        }
        let initial = profile_initial(catalog, profile, phase);
        if initial.is_empty() {
            return Err(ineligible_profile(profile, phase, None));
        }
        if let Some(missing) = initial
            .into_iter()
            .find(|tool| !provider.iter().any(|item| item.name == tool.name))
        {
            return Err(ineligible_profile(profile, phase, Some(&missing.name)));
        }
    }
    let provider_tools = provider
        .iter()
        .map(|tool| without_defaults(tool.definition.clone()))
        .collect();
    let stable_instruction_prefix = instructions::prefix("phase_minimal", phase, &policy)?;
    let stable_provider_cache_prefix = Some(json!({
        "schemaVersion":"butler.stable-provider-cache-prefix.v1",
        "stablePrefixRevision":"butler.btcc-stable-provider-prefix.v4",
        "toolProfileRevision":REVISION,
        "instructionPrefix":stable_instruction_prefix,
    }));
    Ok(GuidedPhaseSelection {
        #[cfg(test)]
        mode: "phase_minimal",
        phase,
        execution_policy: policy.clone(),
        authorized_names: authorized.iter().map(|tool| tool.name.clone()).collect(),
        provider_tools,
        stable_instruction_prefix,
        stable_provider_cache_prefix,
        replay_mode,
    })
}

fn provider_candidates(
    catalog: &GuidedCatalogSnapshot,
    authorized: &[&GuidedCatalogTool],
    policy: &GuidedExecutionPolicy,
    phase: &str,
    required_profiles: &[String],
    image_tool_admitted: bool,
) -> HashSet<String> {
    let mut names = HashSet::new();
    for profile in [
        "public-web",
        if phase == "direct" { "" } else { "workspace" },
        if authorized
            .iter()
            .any(|tool| tool.category.as_deref() == Some("project"))
        {
            "project"
        } else {
            ""
        },
    ] {
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
    if image_tool_admitted {
        names.insert("analyze_attached_image".to_owned());
    }
    for tool in authorized {
        if tool.name == "update_todo_list" {
            names.insert(tool.name.clone());
        }
        if tool.category.as_deref() == Some("control")
            && tool.tags.iter().any(|tag| tag == "bridge")
        {
            names.insert(tool.name.clone());
        }
    }
    if phase == "execution" || policy.subsession.is_some() && policy.tracking_mode != "none" {
        names.extend(
            catalog
                .tools
                .iter()
                .filter(|tool| tool.durable)
                .map(|tool| tool.name.clone()),
        );
    }
    if phase == "execution" && policy.tracking_mode != "none" {
        names.extend(catalog.profile("workTracking").iter().cloned());
    }
    if policy.role == "butler" {
        names.extend(["delegate_to_steward", "steer_steward", "cancel_steward"].map(str::to_owned));
        if policy.access_mode == AccessMode::FullAccess && policy.project_id.is_some() {
            names.insert("bind_session_git_worktree".into());
        }
    }
    if policy.role == "steward" {
        names.extend(["delegate_to_worker", "steer_worker", "wait_for_worker"].map(str::to_owned));
    }
    if policy.role == "butler" {
        names.retain(|name| {
            catalog
                .tool(name)
                .is_none_or(|tool| tool.category.as_deref() != Some("project") || tool.durable)
        });
    }
    names
}

fn phase(policy: &GuidedExecutionPolicy, catalog: &GuidedCatalogSnapshot) -> &'static str {
    if policy.tracking_mode != "none" && (policy.role == "butler" || policy.subsession.is_some()) {
        return "execution";
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
        return if policy.role == "butler" && policy.tracking_mode != "none" {
            "execution"
        } else {
            "direct"
        };
    }
    if policy.access_mode == AccessMode::ReadOnly {
        "read_only"
    } else {
        "execution"
    }
}
fn enabled(flag: &str) -> bool {
    matches!(
        crate::public_text::trim_js_whitespace(flag)
            .to_lowercase()
            .as_str(),
        "1" | "true" | "on" | "yes"
    )
}
fn ineligible_profile(profile: &str, phase: &str, missing: Option<&str>) -> GuidedPreparationError {
    GuidedPreparationError::Policy(match missing {
        Some(name) => {
            format!("required tool profile is ineligible for {phase} phase: {profile} ({name})")
        }
        None => format!("required tool profile is ineligible for {phase} phase: {profile}"),
    })
}
fn without_defaults(mut value: Value) -> Value {
    fn clean(value: &mut Value) {
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
