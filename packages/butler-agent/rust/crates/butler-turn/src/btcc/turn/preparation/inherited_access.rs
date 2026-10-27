//! Snapshot the current ancestry ceiling only when admitting a new turn.
//! Already admitted turns, including continuations, retain their original mode.
use super::DefaultTurnPreparation;
use crate::btcc::guided_turn::GuidedExecutionPolicy;
use crate::btcc::{BtccError, TurnStore, stored_binding_access_mode};
use crate::workspace::StoredSessionBinding;
use serde_json::json;
use std::collections::HashSet;

impl DefaultTurnPreparation {
    async fn inherits_run_access(&self, binding: &StoredSessionBinding) -> Result<bool, BtccError> {
        let from_run = binding
            .metadata
            .as_ref()
            .and_then(|m| m.get("subsession"))
            .is_some_and(|s| s["parent_access_from_turn"] == true);
        if !from_run {
            return Ok(false);
        }
        let run = self
            .repositories
            .child_instruction_run(binding.session_id.clone())
            .await?;
        Ok(run.is_some_and(|run| !run.run_id.is_empty() || run.unattended && !run.connector_event))
    }

    pub(super) async fn inherited_binding(
        &self,
        mut binding: StoredSessionBinding,
    ) -> Result<StoredSessionBinding, BtccError> {
        let mut current = binding.clone();
        let mut mode = stored_binding_access_mode(&binding);
        let mut seen = HashSet::new();
        loop {
            if !seen.insert(current.session_id.clone()) {
                return Err(invalid());
            }
            let Some(lineage) = current.metadata.as_ref().and_then(|m| m.get("subsession")) else {
                break;
            };
            let Some(parent) = lineage["parent_session_id"].as_str() else {
                return Err(invalid());
            };
            if self.inherits_run_access(&current).await? {
                let turn = lineage["parent_turn_id"].as_str().ok_or_else(invalid)?;
                let admitted = self
                    .repositories
                    .find_turn(turn)
                    .await?
                    .filter(|t| t.session_id == parent)
                    .ok_or_else(invalid)?;
                let policy =
                    GuidedExecutionPolicy::from_turn(&admitted, "").map_err(|_| invalid())?;
                mode = mode.narrower(policy.access_mode);
                break;
            }
            current = self
                .binding_store
                .get_by_session_id(parent)
                .await
                .map_err(BtccError::from)?
                .ok_or_else(invalid)?;
            if current
                .metadata
                .as_ref()
                .is_none_or(|m| !m.contains_key("subsession"))
            {
                if let Some(resolve) = &self.parent_access {
                    mode = mode.narrower(resolve(current.clone()).await?);
                } else {
                    mode = mode.narrower(stored_binding_access_mode(&current));
                }
                break;
            }
            mode = mode.narrower(stored_binding_access_mode(&current));
        }
        if seen.len() > 1
            || binding
                .metadata
                .as_ref()
                .is_some_and(|m| m.contains_key("subsession"))
        {
            let metadata = binding.metadata.get_or_insert_default();
            let policy = metadata.entry("runtimePolicy").or_insert_with(|| json!({}));
            policy["accessMode"] = json!(mode);
        }
        Ok(binding)
    }
}
fn invalid() -> BtccError {
    BtccError::relayed(
        "delegation_parent_policy_invalid",
        "Work parent policy is unavailable.",
    )
}
