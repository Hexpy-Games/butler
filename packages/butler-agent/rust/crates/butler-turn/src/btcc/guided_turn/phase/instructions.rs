use std::collections::HashMap;
use std::sync::OnceLock;

use super::super::work::GuidedPreparationError;
use super::policy::{GuidedExecutionPolicy, PolicyRole};
use super::selection::{GuidedPhase, SurfaceMode};

static PREFIXES: OnceLock<HashMap<String, String>> = OnceLock::new();

pub(super) fn prefix(
    mode: SurfaceMode,
    phase: GuidedPhase,
    policy: &GuidedExecutionPolicy,
) -> Result<String, GuidedPreparationError> {
    // Every guided E2E turn parses the bundled table; were it malformed,
    // every lookup below would report the prefix as unavailable.
    let prefixes = PREFIXES.get_or_init(|| {
        serde_json::from_str(include_str!("instruction-prefixes.json")).unwrap_or_default()
    });
    let key = if policy.subsession.is_some() && policy.role == PolicyRole::Steward {
        let submode = policy
            .subsession
            .as_ref()
            .and_then(|value| value.execution_mode.as_deref())
            .unwrap_or("mutation");
        format!(
            "delegated|steward|{}|{submode}",
            policy.access_mode.as_str()
        )
    } else if policy.subsession.is_some() && policy.role == PolicyRole::Worker {
        format!("delegated|worker|{}", policy.access_mode.as_str())
    } else if mode == SurfaceMode::Legacy {
        format!(
            "legacy|butler|{}|{}",
            policy.access_mode.as_str(),
            policy.tracking_mode
        )
    } else {
        format!("phase_minimal|butler|{}", phase.as_str())
    };
    let mut value = prefixes
        .get(&key)
        .ok_or_else(|| {
            GuidedPreparationError::Policy(format!("guided instruction prefix unavailable: {key}"))
        })?
        .clone();
    if key.contains("delegated|steward") && key.ends_with("mutation") {
        let scope = policy
            .subsession
            .as_ref()
            .and_then(|value| value.mutation_scope.as_ref())
            .ok_or(GuidedPreparationError::Contract(
                "invalid_subsession_contract",
            ))?
            .join("; ");
        value = value.replace("__GUIDED_MUTATION_SCOPE__", &scope);
    }
    value.push_str("\nWork and Plan track progress and reviews; they never authorize or restrict tool calls. Permission mode and the exact operation approval rules govern execution. Ask-first requests approval at execution time; full access runs directly. Do not invent Plan effect declarations.\nThe initial personal-folder inventory and move proposal awaiting confirmation are one bounded direct observation: keep this step in Butler, with optional Work tracking, and delegate execution only after the concrete move plan is approved.\nFor a broad request to organize an existing personal folder, first resolve the named folder from the operating-system known-folder settings or actual user profile. Never substitute the active workspace, service data directory, or temporary HOME for a user-named personal folder. Inspect its top-level entries read-only (including hidden entries), returning compact complete JSON totals for files and folders and counts grouped by extension rather than a per-file listing. Report every extension count and propose concrete destination folders. Ask for confirmation of that specific move plan before moving, renaming or deleting files, even in full access. An explicitly approved move plan may proceed.\n");
    Ok(value)
}
