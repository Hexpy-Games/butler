//! Resolve the current owner ceiling at each child admission and explicit resume.
use super::DefaultTurnPreparation;
use crate::btcc::guided_turn::GuidedExecutionPolicy;
use crate::btcc::{BtccError, TurnStore, stored_binding_access_mode};
use crate::workspace::StoredSessionBinding;
use serde_json::json;
use std::collections::HashSet;

impl DefaultTurnPreparation {
    pub(super) async fn inherited_resume_command(
        &self,
        request: &crate::btcc::TurnRequest,
    ) -> Result<crate::btcc::TurnCommand, BtccError> {
        let mut command = super::request::resume_command(request);
        let binding = self
            .binding_store
            .get_by_session_id(&request.session_id)
            .await
            .map_err(BtccError::from)?;
        let Some(binding) = binding.filter(|b| {
            b.metadata
                .as_ref()
                .is_some_and(|m| m.contains_key("subsession"))
        }) else {
            return Ok(command);
        };
        let inherited = self.inherited_binding(binding.clone()).await?;
        let mode = stored_binding_access_mode(&inherited);
        if let crate::btcc::TurnCommand::Resume(resume) = &mut command {
            resume.access_ceiling = Some(mode.clone());
            let runtime = binding
                .metadata
                .as_ref()
                .and_then(|m| m.get("runtimePolicy"));
            resume.released_tools = requirements(runtime, "requiredNativeTools");
            resume
                .released_tools
                .extend(requirements(runtime, "required_tools"));
            resume
                .released_tools
                .retain(|name| !requirement_allowed(&mode, name));
            if binding.role == crate::workspace::SessionRole::Worker
                && mode != crate::btcc::AccessMode::FullAccess
            {
                resume.released_profiles = requirements(runtime, "requiredNativeToolProfiles");
            }
        }
        Ok(command)
    }

    async fn run_access(
        &self,
        current: &StoredSessionBinding,
        run: crate::btcc::ScheduleRunContext,
        parent: &str,
        lineage: &serde_json::Value,
    ) -> Result<crate::btcc::AccessMode, BtccError> {
        if let Some(resolve) = &self.parent_access {
            return resolve(current.clone(), Some(run)).await;
        }
        let turn = lineage["parent_turn_id"].as_str().ok_or_else(invalid)?;
        let admitted = self
            .repositories
            .find_turn(turn)
            .await?
            .filter(|t| t.session_id == parent)
            .ok_or_else(invalid)?;
        Ok(GuidedExecutionPolicy::from_turn(&admitted, "")
            .map_err(|_| invalid())?
            .access_mode)
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
            let run = self
                .repositories
                .child_instruction_run(current.session_id.clone())
                .await?;
            if let Some(run) = run.filter(|r| !r.automation_id.is_empty()) {
                mode = mode.narrower(self.run_access(&current, run, parent, lineage).await?);
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
                    mode = mode.narrower(resolve(current.clone(), None).await?);
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
            // Required capabilities cannot override the current owner ceiling.
            for field in ["requiredNativeTools", "required_tools"] {
                if let Some(tools) = policy
                    .get_mut(field)
                    .and_then(serde_json::Value::as_array_mut)
                {
                    tools.retain(|v| {
                        v.as_str()
                            .is_none_or(|name| requirement_allowed(&mode, name))
                    });
                }
            }
            if binding.role == crate::workspace::SessionRole::Worker {
                policy["requiredNativeToolProfiles"] =
                    if mode == crate::btcc::AccessMode::FullAccess {
                        json!(["workspace"])
                    } else {
                        json!([])
                    };
            }
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

fn requirements(runtime: Option<&serde_json::Value>, field: &str) -> Vec<String> {
    runtime
        .and_then(|r| r.get(field))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn requirement_allowed(mode: &crate::btcc::AccessMode, name: &str) -> bool {
    use crate::btcc::{
        AccessDecision, AccessRequest, ApprovalRisk, CapabilityKind, TargetScope, TurnTaint,
    };
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
