use super::GuidedExecutionPolicy;
use crate::btcc::{
    AccessDecision, AccessMode, AccessRequest, ApprovalRisk, CapabilityKind, TargetScope,
    TurnRecord, TurnTaint,
};
use serde_json::{Value, json};

/// Project an answered permission revision without retaining revoked tool requirements.
pub fn project_turn_access_mode(turn: &mut TurnRecord, mode: &AccessMode) {
    turn.model_selection
        .controls
        .insert("accessMode".into(), json!(mode));
    let Some(policy) = turn
        .context
        .get_mut("executionPolicy")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    policy.insert("accessMode".into(), json!(mode));
    for field in ["requiredNativeTools", "required_tools"] {
        if let Some(tools) = policy.get_mut(field).and_then(Value::as_array_mut) {
            tools.retain(|tool| {
                tool.as_str()
                    .is_none_or(|name| GuidedExecutionPolicy::requirement_allowed(mode, name))
            });
        }
    }
    if policy.get("role").and_then(Value::as_str) == Some("worker")
        && *mode != AccessMode::FullAccess
    {
        policy.insert("requiredNativeToolProfiles".into(), json!([]));
    }
}

impl GuidedExecutionPolicy {
    pub(crate) fn requirement_allowed(mode: &AccessMode, name: &str) -> bool {
        !matches!(
            crate::btcc::decide(
                mode,
                AccessRequest {
                    kind: CapabilityKind::of_call(name, &serde_json::Map::new(), false),
                    risk: ApprovalRisk::High,
                    scope: TargetScope::NoTarget,
                    taint: TurnTaint::Clean,
                }
            ),
            AccessDecision::Deny(_)
        )
    }
}
