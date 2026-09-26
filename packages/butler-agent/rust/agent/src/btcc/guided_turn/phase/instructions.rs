use std::collections::HashMap;
use std::sync::OnceLock;

use super::super::work::GuidedPreparationError;
use super::policy::GuidedExecutionPolicy;

static PREFIXES: OnceLock<HashMap<String, String>> = OnceLock::new();

pub(super) fn prefix(
    mode: &str,
    phase: &str,
    policy: &GuidedExecutionPolicy,
) -> Result<String, GuidedPreparationError> {
    let prefixes = PREFIXES.get_or_init(|| {
        serde_json::from_str(include_str!("instruction-prefixes.json"))
            .expect("source-generated immutable guided instruction prefixes")
    });
    let key = if policy.subsession.is_some() && policy.role == "steward" {
        let submode = policy
            .subsession
            .as_ref()
            .and_then(|value| value.get("executionMode"))
            .and_then(|value| value.as_str())
            .unwrap_or("mutation");
        format!(
            "delegated|steward|{}|{submode}",
            policy.access_mode.as_str()
        )
    } else if policy.subsession.is_some() && policy.role == "worker" {
        format!("delegated|worker|{}", policy.access_mode.as_str())
    } else if mode == "legacy" {
        format!(
            "legacy|butler|{}|{}",
            policy.access_mode.as_str(),
            policy.tracking_mode
        )
    } else {
        format!("phase_minimal|butler|{phase}")
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
            .and_then(|value| value.get("mutationScope"))
            .and_then(|value| value.as_array())
            .ok_or(GuidedPreparationError::Contract(
                "invalid_subsession_contract",
            ))?
            .iter()
            .map(|value| {
                value.as_str().ok_or(GuidedPreparationError::Contract(
                    "invalid_subsession_contract",
                ))
            })
            .collect::<Result<Vec<_>, _>>()?
            .join("; ");
        value = value.replace("__GUIDED_MUTATION_SCOPE__", &scope);
    }
    Ok(value)
}
