//! Typed child continuation, carried by the existing blocked disposition/outbox.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A missing child capability is a parent continuation, never user homework.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityHandoff {
    pub code: CapabilityHandoffCode,
    pub requested_action: RequestedCapabilityAction,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum CapabilityHandoffCode {
    #[serde(rename = "capability_unavailable_in_child")]
    UnavailableInChild,
}

/// Arguments are hints, not authority; the parent uses its normal effect guard.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestedCapabilityAction {
    pub tool_name: String,
    // Passthrough: arguments of the requested tool, validated by its executor.
    pub arguments: Map<String, Value>,
}

impl CapabilityHandoff {
    /// Decode the structured next condition of a blocked child disposition.
    pub fn from_condition(condition: &str) -> Option<Self> {
        serde_json::from_str(condition).ok()
    }

    /// Decode the dedicated field in a durable parent result input.
    pub fn from_parent_input(input: &str) -> Option<Self> {
        input.strip_prefix("Delegated result\n")?;
        input.lines().find_map(|line| {
            line.strip_prefix("capability_handoff: ")
                .and_then(Self::from_condition)
        })
    }
}
