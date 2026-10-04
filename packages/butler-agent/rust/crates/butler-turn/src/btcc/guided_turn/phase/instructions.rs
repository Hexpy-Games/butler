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
    value.push_str("\nRead-only observations never need a declared persistent Plan effect. If a tool returns recoverable effect-contract feedback, follow next_action and required_effect to amend and review the Plan, then retry in this same turn; do not abandon the task or ask the user to repair runtime policy.\nFor a broad request to organize an existing personal folder, first inspect its top-level entries read-only, report total files and folders and complete counts by type (including hidden entries), and propose concrete destination folders. Ask for confirmation of that specific move plan before moving, renaming or deleting files, even in full access. An explicitly approved move plan may proceed.\n");
    Ok(value)
}
