//! Refuse changes before approval or effect preparation until this Plan is accepted.
use super::GuidedTools;
use butler_turn::btcc::{
    AccessDecision, AccessMode, AccessRequest, ApprovalRisk, BtccError, CapabilityKind, DenyReason,
    ModelRoundToolCall, TargetScope, ToolExecutionError, TurnTaint, decide,
};
use serde_json::{Map, Value};

pub(in crate::host::guided::tools) async fn check(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
) -> Result<(), ToolExecutionError> {
    let (name, arguments, _) = super::super::discovery::effective(call);
    let arguments = arguments.as_object().unwrap_or(&call.arguments);
    if !mutating(&name, arguments, owner.catalog.steward_plan_effect(&name)) {
        return Ok(());
    }
    if owner
        .subsessions
        .steward_plan_ready(&owner.binding.source_session_id, &owner.binding.turn_id)
        .await
        .map_err(ToolExecutionError::Integrity)?
        == Some(false)
    {
        return Err(ToolExecutionError::Integrity(BtccError::relayed(
            "steward_plan_review_required",
            "Record your Plan with replace_work_plan and accept it with record_work_review (subject plan) before this change. Read-only inspection may continue. Nothing was changed.",
        )));
    }
    Ok(())
}

fn mutating(name: &str, args: &Map<String, Value>, catalog_effect: bool) -> bool {
    if name == "run_command" {
        return !matches!(
            args.get("state_effect").and_then(Value::as_str),
            None | Some("read_only" | "validation" | "remote_observation")
        );
    }
    if name == "browser_act" {
        // Pointer/keyboard input can change page state even without a commit.
        // Only explicit observation/navigation actions are known to inspect.
        return args
            .get("steps")
            .and_then(Value::as_array)
            .is_none_or(|steps| {
                steps.iter().any(|step| {
                    step["commits"] == true
                        || !matches!(
                            step["action"].as_str(),
                            Some("scroll" | "hover" | "wait" | "back" | "forward" | "reload")
                        )
                })
            });
    }
    let decision = decide(
        &AccessMode::ReadOnly,
        AccessRequest {
            kind: CapabilityKind::of_call(name, args, false),
            risk: ApprovalRisk::Low,
            scope: TargetScope::NoTarget,
            taint: TurnTaint::Clean,
        },
    );
    catalog_effect
        || matches!(
            decision,
            AccessDecision::Deny(DenyReason::ReadOnly | DenyReason::FullAccessRequired)
        )
}

#[cfg(test)]
pub(in crate::host::guided::tools) mod tests {
    use super::*;
    use serde_json::json;

    pub(in crate::host::guided) fn assert_steward_mutation_predicate() {
        let source = butler_core::tool_catalog::load().unwrap();
        let catalog = butler_turn::btcc::GuidedCatalogSnapshot::parse(&source.to_string()).unwrap();
        let effects: std::collections::HashSet<_> = catalog.steward_plan_effects().collect();
        for name in [
            "document_create",
            "document_edit",
            "output_publish",
            "deliver_files",
            "library_organize",
            "preview_start",
            "set_wallpaper",
        ] {
            assert!(
                mutating(name, &Map::new(), effects.contains(name)),
                "{name}"
            );
        }
        for (name, args, effect, expected) in [
            ("write_file", json!({}), true, true),
            ("read_file", json!({}), false, false),
            (
                "run_command",
                json!({"state_effect":"mutation"}),
                true,
                true,
            ),
            (
                "run_command",
                json!({"state_effect":"remote_observation"}),
                true,
                false,
            ),
            (
                "run_command",
                json!({"state_effect":"validation"}),
                true,
                false,
            ),
            ("document_create", json!({}), true, true),
            ("deliver_files", json!({}), true, true),
            ("delegate_to_worker", json!({}), false, false),
            ("replace_work_plan", json!({}), false, false),
            (
                "browser_act",
                json!({"steps":[{"action":"back"}]}),
                true,
                false,
            ),
            (
                "browser_act",
                json!({"steps":[{"action":"fill"}]}),
                true,
                true,
            ),
            (
                "browser_act",
                json!({"steps":[{"action":"click","commits":true}]}),
                true,
                true,
            ),
        ] {
            assert_eq!(
                mutating(name, args.as_object().unwrap(), effect),
                expected,
                "{name}: {args}"
            );
        }
    }
}
