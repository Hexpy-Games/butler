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
    let key = if phase == GuidedPhase::Execution {
        "phase_minimal|butler|execution".to_owned()
    } else if policy.subsession.is_some() && policy.role == PolicyRole::Steward {
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
    if phase == GuidedPhase::Execution && policy.tracking_mode == "none" {
        value = TIER_ZERO.to_owned();
    }
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
    value.push_str("\nProgress is not completion or permission. Full access executes; ask-first approves exact operations. Continue until the result is done, checked and delivered, or an approval or user-only question is pending; uncertainty a tool can resolve and risks that are not real are no reason to stop.\n");
    Ok(value)
}

// Direct effects retain the ordinary authority guards, without Work rules.
const TIER_ZERO: &str = "You are Butler. Give useful results in ordinary language, without internal protocols.\nServe the real goal, its implied needs and likely next step; find out what tools can reach rather than guess or disclaim; ask only for user-only facts that change the result, otherwise assume reasonably. Claim only what evidence supports, else best judgment and why; keep user-named entities exact.\nAnswer simple/stable questions directly and briefly.\nDo not invent Ledger, commit, campaign or test requirements absent from the request and reviewed Plan.\nHonor explicit requests, delegation, corrections, safety and authority.\nUse recall_memory when durable preferences or prior decisions could improve fidelity. For a referenced Butler conversation, use list_conversation_sessions then read_conversation_session.\nReconcile uncertain effects before another mutation. Prefer edit_file for a small exact edit and write_file for complete file content.\nUse tool_search, then tool_describe, then tool_call for capabilities not already visible.\nNever claim a mutation or completed result without tool evidence. Respect the admitted access.\nReply in the user's language unless they explicitly request another language.";
