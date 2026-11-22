//! What the main hands a registered computer: a read-only copy of its
//! all-chats instructions and its profile.
use std::sync::Arc;

use butler_gateway::gateway::GatewayApplicationError;
use butler_memory::cognition::RememberedRuleOwner;
use butler_memory::profile::ProfileService;
use butler_turn::context_ports::{ProfilePromptPort, PromptProjectionInput};
use butler_turn::remote_memory::{CopiedRule, MemoryCopy};
use serde_json::Value;

pub(crate) struct ComputerMemory {
    pub(crate) rules: Arc<RememberedRuleOwner>,
    pub(crate) profile: Arc<ProfileService>,
}

impl ComputerMemory {
    /// Project and chat-scoped instructions stay on the main: a computer's
    /// sessions have no main project, and their chat instructions are task 9.
    pub(super) async fn copy(&self) -> Result<Value, GatewayApplicationError> {
        let rules = self
            .rules
            .list()
            .await
            .map_err(|_| GatewayApplicationError::internal())?;
        let input = PromptProjectionInput {
            session_id: "",
            project_id: None,
        };
        let naming_profile = self
            .profile
            .naming_profile(&input)
            .await
            .map_err(|_| GatewayApplicationError::internal())?;
        let runtime_profile = self
            .profile
            .runtime_profile(&input)
            .await
            .map_err(|_| GatewayApplicationError::internal())?;
        let rules = rules
            .into_iter()
            .filter(|rule| rule.project_id.is_none() && rule.scope_session_id.is_none())
            .map(|rule| CopiedRule {
                handle: rule.handle,
                text: rule.text,
                revision: rule.revision,
                expires_at: rule.expires_at,
            })
            .collect();
        serde_json::to_value(MemoryCopy {
            rules,
            naming_profile,
            runtime_profile,
        })
        .map_err(GatewayApplicationError::internal_from)
    }
}
