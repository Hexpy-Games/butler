//! What each access mode lets a turn do without asking the user first.
//!
//! Ask-first asks before every effect, with exactly three exceptions the
//! owner granted (#236): saving first-conversation onboarding answers, saving
//! a memory, and analyzing an image the user attached. The exceptions are
//! keyed by the action a built-in tool performs, never by a tool category or
//! effect boundary, so an MCP tool (even one that analyzes images) still asks.

use butler_core::tool_protocol::ToolName;

use super::AccessMode;
use crate::workspace::StoredSessionBinding;

/// An action that ask-first access lets proceed without an approval.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalExemptAction {
    /// Saving the answers of the first-conversation onboarding (and reading
    /// back the profile they build).
    FirstConversationOnboarding,
    /// Saving a memory.
    MemorySave,
    /// Analyzing an image the user attached to the current message.
    AttachedImageAnalysis,
}

impl ApprovalExemptAction {
    /// The exempt action the built-in tool `name` performs, if any.
    pub fn of_tool(name: &str) -> Option<Self> {
        match ToolName::parse(name)? {
            ToolName::UpdateOnboardingProfile | ToolName::SummarizeUserProfile => {
                Some(Self::FirstConversationOnboarding)
            }
            ToolName::UpdateExplicitMemory | ToolName::IngestTaskMemory => Some(Self::MemorySave),
            ToolName::AnalyzeAttachedImage => Some(Self::AttachedImageAnalysis),
            _ => None,
        }
    }
}

impl AccessMode {
    /// Whether a turn with this access may perform `action` without asking:
    /// full access and ask-first may, read-only never does.
    pub fn allows_without_approval(&self, action: ApprovalExemptAction) -> bool {
        decide(
            self,
            AccessRequest {
                kind: CapabilityKind::Exempt(action),
                risk: super::ApprovalRisk::Medium,
                scope: TargetScope::NoTarget,
                taint: TurnTaint::Clean,
            },
        ) == AccessDecision::Allow
    }

    /// Whether a turn with this access may run the built-in tool `name`
    /// without asking because the tool performs an exempt action.
    pub fn exempts_tool(&self, name: &str) -> bool {
        ApprovalExemptAction::of_tool(name)
            .is_some_and(|action| self.allows_without_approval(action))
    }
}

/// The access mode a turn without execution controls (a schedule the model
/// created, a control request) runs with on `binding`: the binding's runtime
/// policy mode, else its metadata mode, else read-only. An App turn stores
/// its conversation's own mode there, never a per-message override (#237).
pub fn stored_binding_access_mode(binding: &StoredSessionBinding) -> AccessMode {
    let metadata = binding.metadata.as_ref();
    metadata
        .and_then(|fields| fields.get("runtimePolicy"))
        .and_then(|policy| policy.get("accessMode"))
        .filter(|value| !value.is_null())
        .or_else(|| metadata.and_then(|fields| fields.get("accessMode")))
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or(AccessMode::ReadOnly)
}

mod decision;
mod mode;
pub use decision::*;
#[cfg(test)]
mod tests;
