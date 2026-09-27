use std::collections::HashSet;

use butler_core::tool_protocol::ToolName;
use serde_json::{Value, json};

use crate::btcc::agent_loop::ReplayMode;
use crate::btcc::{AccessMode, TurnRecord};

use super::super::work::GuidedPreparationError;
use super::catalog::{GuidedCatalogSnapshot, GuidedCatalogTool};
use super::instructions;
use super::policy::GuidedExecutionPolicy;
use super::visibility::{
    legacy_authorized, legacy_visible, phase_allows, profile_initial, turn_admits_zai_image_tool,
};

const REVISION: &str = "butler.btcc-tool-instruction-policy.v2";

#[derive(Clone, Copy)]
pub struct GuidedPhaseInput<'a> {
    pub turn: &'a TurnRecord,
    pub catalog: &'a GuidedCatalogSnapshot,
    pub phase_surface_flag: &'a str,
    pub operation_replay_flag: &'a str,
    pub default_workspace: &'a str,
}

/// The phase of a guided turn, which bounds the tools it may be offered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuidedPhase {
    /// No workspace or project: answer directly with read-only tools.
    Direct,
    /// Workspace or project access without effects.
    ReadOnly,
    /// Effects and durable Work are allowed.
    Execution,
}

impl GuidedPhase {
    /// The name used in instruction-prefix keys and policy messages.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::ReadOnly => "read_only",
            Self::Execution => "execution",
        }
    }
}

/// How the provider tool surface is selected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceMode {
    /// The pre-phase surface: every authorized tool the policy makes visible.
    Legacy,
    /// The minimal surface of the phase and the required profiles.
    PhaseMinimal,
}

impl SurfaceMode {
    /// The name used in instruction-prefix keys.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::PhaseMinimal => "phase_minimal",
        }
    }
}

/// The tools, instructions and replay mode selected for a guided turn.
#[derive(Debug)]
pub struct GuidedPhaseSelection {
    #[cfg(any(test, feature = "test-support"))]
    pub mode: SurfaceMode,
    pub phase: GuidedPhase,
    pub execution_policy: GuidedExecutionPolicy,
    pub authorized_names: Vec<String>,
    /// Provider tool definitions (JSON Schema passthrough from the catalog).
    pub provider_tools: Vec<Value>,
    pub stable_instruction_prefix: String,
    /// The stable provider cache prefix (provider passthrough JSON).
    pub stable_provider_cache_prefix: Option<Value>,
    pub replay_mode: ReplayMode,
}

/// The exact operation-result readers, offered on every surface.
const EXACT_READ_TOOLS: [&str; 2] = ["read_operation_results", "list_operation_results"];

/// Selects the guided turn's phase, authorized tools and provider surface.
pub fn select_phase(
    input: GuidedPhaseInput<'_>,
) -> Result<GuidedPhaseSelection, GuidedPreparationError> {
    let policy = GuidedExecutionPolicy::from_turn(input.turn, input.default_workspace)?;
    let catalog = input.catalog;
    let image_tool_admitted = turn_admits_zai_image_tool(&policy);
    let mut authorized = base_authorized(input, &policy, image_tool_admitted);
    let phase = phase(&policy, catalog);
    let replay_mode = if enabled(input.operation_replay_flag) {
        ReplayMode::Available
    } else {
        ReplayMode::Disabled
    };
    if !enabled(input.phase_surface_flag) {
        let mut provider = legacy_visible(&authorized, &policy);
        push_missing(&mut provider, catalog, &EXACT_READ_TOOLS);
        return Ok(GuidedPhaseSelection {
            #[cfg(any(test, feature = "test-support"))]
            mode: SurfaceMode::Legacy,
            phase,
            execution_policy: policy.clone(),
            authorized_names: authorized.iter().map(|tool| tool.name.clone()).collect(),
            provider_tools: provider
                .iter()
                .map(|tool| tool.definition.clone())
                .collect(),
            stable_instruction_prefix: instructions::prefix(SurfaceMode::Legacy, phase, &policy)?,
            stable_provider_cache_prefix: None,
            replay_mode,
        });
    }
    let required_profiles = required_profiles(catalog, &policy, phase)?;
    admit_phase_tools(&mut authorized, catalog, &policy, &required_profiles);
    authorized.retain(|tool| {
        (tool.durable && policy.subsession.is_some() && policy.tracking_mode != "none"
            || phase_allows(phase, tool))
            && (tool.name != ToolName::AnalyzeAttachedImage || image_tool_admitted)
    });
    require_tools(&authorized, &policy, phase)?;
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
                    ToolName::parse(tool.name.as_str()),
                    Some(ToolName::ReadOperationResults | ToolName::ListOperationResults)
                )
        })
        .copied()
        .collect();
    require_tools(&provider, &policy, phase)?;
    require_profiles_offered(catalog, &authorized, &provider, &required_profiles, phase)?;
    let stable_instruction_prefix =
        instructions::prefix(SurfaceMode::PhaseMinimal, phase, &policy)?;
    let stable_provider_cache_prefix = Some(json!({
        "schemaVersion":"butler.stable-provider-cache-prefix.v1",
        "stablePrefixRevision":"butler.btcc-stable-provider-prefix.v4",
        "toolProfileRevision":REVISION,
        "instructionPrefix":stable_instruction_prefix,
    }));
    Ok(GuidedPhaseSelection {
        #[cfg(any(test, feature = "test-support"))]
        mode: SurfaceMode::PhaseMinimal,
        phase,
        execution_policy: policy.clone(),
        authorized_names: authorized.iter().map(|tool| tool.name.clone()).collect(),
        provider_tools: provider
            .iter()
            .map(|tool| without_defaults(tool.definition.clone()))
            .collect(),
        stable_instruction_prefix,
        stable_provider_cache_prefix,
        replay_mode,
    })
}

/// The legacy authorization plus the exact result readers; the image tool
/// only when this turn admits it.
fn base_authorized<'a>(
    input: GuidedPhaseInput<'a>,
    policy: &GuidedExecutionPolicy,
    image_tool_admitted: bool,
) -> Vec<&'a GuidedCatalogTool> {
    let context = &input.turn.context;
    let project_ref = context
        .get("projectRef")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let project_sources = context
        .get("projectSources")
        .and_then(Value::as_array)
        .is_some_and(|value| !value.is_empty());
    let mut authorized = legacy_authorized(input.catalog, policy, project_ref, project_sources);
    authorized.retain(|tool| tool.name != ToolName::AnalyzeAttachedImage || image_tool_admitted);
    // Current source exact-read capability is always available, independently of replay replacement.
    push_missing(&mut authorized, input.catalog, &EXACT_READ_TOOLS);
    authorized
}

/// Appends the catalog tools named in `names` that are not in `tools` yet.
fn push_missing<'a>(
    tools: &mut Vec<&'a GuidedCatalogTool>,
    catalog: &'a GuidedCatalogSnapshot,
    names: &[&str],
) {
    for name in names {
        if let Some(tool) = catalog.tool(name)
            && !tools.iter().any(|item| item.name == tool.name)
        {
            tools.push(tool);
        }
    }
}

/// The required profiles that shape the surface (the butler never takes the
/// project profiles here). Unknown profiles, and effect profiles outside the
/// execution phase, are refused.
fn required_profiles(
    catalog: &GuidedCatalogSnapshot,
    policy: &GuidedExecutionPolicy,
    phase: GuidedPhase,
) -> Result<Vec<String>, GuidedPreparationError> {
    for profile in &policy.required_profiles {
        let name = butler_core::public_text::trim_js_whitespace(profile);
        if !name.is_empty() && !catalog.profiles.contains_key(name) {
            return Err(GuidedPreparationError::Policy(format!(
                "unknown required tool profile: {name}"
            )));
        }
    }
    let required: Vec<_> = policy
        .required_profiles
        .iter()
        .filter(|profile| {
            policy.role != "butler" || !matches!(profile.as_str(), "project" | "project-lifecycle")
        })
        .cloned()
        .collect();
    if phase == GuidedPhase::Execution {
        return Ok(required);
    }
    for profile in required.iter().filter(|profile| *profile != "project") {
        let effect = catalog.profile(profile).iter().any(|name| {
            catalog
                .tool(name)
                .is_some_and(|tool| tool.effect_boundary.as_deref() != Some("none"))
        });
        if effect {
            return Err(ineligible_profile(profile, phase, None));
        }
    }
    Ok(required)
}

/// Adds the required profiles' tools (all of them with full access, else only
/// already authorized ones) and the role's delegation tools.
fn admit_phase_tools<'a>(
    authorized: &mut Vec<&'a GuidedCatalogTool>,
    catalog: &'a GuidedCatalogSnapshot,
    policy: &GuidedExecutionPolicy,
    required_profiles: &[String],
) {
    let base_names: HashSet<String> = authorized.iter().map(|tool| tool.name.clone()).collect();
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
    let delegation: &[&str] = match policy.role.as_str() {
        "butler" => &["delegate_to_steward", "steer_steward", "cancel_steward"],
        "steward" => &["delegate_to_worker", "steer_worker", "wait_for_worker"],
        _ => &[],
    };
    push_missing(authorized, catalog, delegation);
}

fn require_tools(
    tools: &[&GuidedCatalogTool],
    policy: &GuidedExecutionPolicy,
    phase: GuidedPhase,
) -> Result<(), GuidedPreparationError> {
    match policy
        .required_tools
        .iter()
        .find(|name| !tools.iter().any(|tool| &tool.name == *name))
    {
        Some(name) => Err(GuidedPreparationError::Policy(format!(
            "required tool is ineligible for {} phase: {name}",
            phase.as_str()
        ))),
        None => Ok(()),
    }
}

/// Every required profile must reach the provider surface: project lifecycle
/// needs the execution phase and every ledger effect; other profiles need
/// their initial tools offered.
fn require_profiles_offered(
    catalog: &GuidedCatalogSnapshot,
    authorized: &[&GuidedCatalogTool],
    provider: &[&GuidedCatalogTool],
    required_profiles: &[String],
    phase: GuidedPhase,
) -> Result<(), GuidedPreparationError> {
    for profile in required_profiles {
        if profile == "project-lifecycle" {
            if phase != GuidedPhase::Execution
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
    Ok(())
}

/// Names of the tools the provider surface offers: initial tools of the
/// always-on and required profiles, memory startup tools, required tools,
/// bridges, Work tools where Work is tracked, and the role's delegation tools.
fn provider_candidates(
    catalog: &GuidedCatalogSnapshot,
    authorized: &[&GuidedCatalogTool],
    policy: &GuidedExecutionPolicy,
    phase: GuidedPhase,
    required_profiles: &[String],
    image_tool_admitted: bool,
) -> HashSet<String> {
    let mut names = profile_candidates(catalog, authorized, policy, phase, required_profiles);
    if image_tool_admitted {
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
fn profile_candidates(
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
fn add_role_tools(
    names: &mut HashSet<String>,
    catalog: &GuidedCatalogSnapshot,
    policy: &GuidedExecutionPolicy,
) {
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
}

fn phase(policy: &GuidedExecutionPolicy, catalog: &GuidedCatalogSnapshot) -> GuidedPhase {
    if policy.tracking_mode != "none" && (policy.role == "butler" || policy.subsession.is_some()) {
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
        return if policy.role == "butler" && policy.tracking_mode != "none" {
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
fn enabled(flag: &str) -> bool {
    matches!(
        butler_core::public_text::trim_js_whitespace(flag)
            .to_lowercase()
            .as_str(),
        "1" | "true" | "on" | "yes"
    )
}
fn ineligible_profile(
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
