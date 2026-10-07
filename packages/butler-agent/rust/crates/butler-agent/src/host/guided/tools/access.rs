//! Admission decisions and blocking target classification for guided tools.
use super::GuidedTools;
use butler_turn::btcc::{
    AccessDecision, AccessRequest, ApprovalRisk, BtccError, CapabilityKind, ModelRoundToolCall,
    TargetScope, TurnTaint, command_access_risk, command_scope_unresolved, decide, needs_scope,
};
use butler_turn::workspace::{ScopeRoots, classify_targets};
use serde_json::Value;

pub(super) fn kind(call: &ModelRoundToolCall) -> CapabilityKind {
    CapabilityKind::of_call(
        &call.name,
        &call.arguments,
        super::effect::is_managed_project_ledger_effect(&call.name),
    )
}
pub(super) async fn decision(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    args: &Value,
) -> Result<AccessDecision, BtccError> {
    let kind = kind(call);
    let scope = if needs_scope(&owner.binding.access_mode, kind) {
        target_scope(owner, call, args).await?
    } else {
        TargetScope::NoTarget
    };
    Ok(decide(
        &owner.binding.access_mode,
        AccessRequest {
            kind,
            scope,
            risk: if call.name == "run_command" {
                command_access_risk(args["command"].as_str().unwrap_or(""))
            } else {
                ApprovalRisk::Medium
            },
            taint: TurnTaint::Clean,
        },
    ))
}
async fn target_scope(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    args: &Value,
) -> Result<TargetScope, BtccError> {
    let root = owner
        .binding
        .workspace_reference
        .as_ref()
        .map(|r| r.get())
        .transpose()
        .map_err(|e| BtccError::relayed(e.code(), "Workspace unavailable"))?
        .unwrap_or_else(|| owner.binding.workspace_path.clone());
    let project = owner.binding.project_folder.as_ref().map(|_| root.clone());
    let data = owner.binding.butler_data.clone();
    let protected = owner.binding.protected_ledger_roots.clone();
    let installation = owner.binding.installation_root.clone();
    let args = args.clone();
    let name = call.name.clone();
    tokio::task::spawn_blocking(move || {
        let roots = ScopeRoots {
            project: project.as_deref(),
            butler_data: &data,
            protected_ledger_roots: &protected,
            installation_root: installation.as_deref(),
        };
        if name == "run_command" {
            let command = args["command"].as_str().unwrap_or("");
            if command_scope_unresolved(command) {
                return TargetScope::Outside;
            }
            let cwd = root.join(args["cwd"].as_str().unwrap_or("."));
            let mut targets = vec![cwd.to_string_lossy().into_owned()];
            targets.extend(
                butler_platform::command_sandbox::path_tokens(command)
                    .into_iter()
                    .filter(|token| {
                        token.contains(['/', '\\', '.'])
                            || std::path::Path::new(token).is_absolute()
                    })
                    .map(butler_platform::command_sandbox::normalize_path_token),
            );
            classify_targets(
                &roots,
                &cwd,
                &targets.iter().map(String::as_str).collect::<Vec<_>>(),
            )
        } else {
            let targets = if name == "read_file" {
                args["requests"]
                    .as_array()
                    .map(|requests| requests.iter().filter_map(|r| r["path"].as_str()).collect())
                    .unwrap_or_default()
            } else {
                vec![args["root"].as_str().unwrap_or(".")]
            };
            classify_targets(&roots, &root, &targets)
        }
    })
    .await
    .map_err(|e| BtccError::relayed("scope_classification_failed", e.to_string()))
}
pub(super) fn resumes(owner: &GuidedTools, occurrence: &str) -> bool {
    owner.binding.authority_request_ref.is_some()
        && owner.binding.authority_source_call_id.as_deref() == Some(occurrence)
        && !*owner.authority_consumed.lock()
}

/// Boundaries whose decision never depends on the filesystem.
pub(super) fn for_kind(owner: &GuidedTools, kind: CapabilityKind) -> AccessDecision {
    decide(
        &owner.binding.access_mode,
        AccessRequest {
            kind,
            risk: ApprovalRisk::Medium,
            scope: TargetScope::NoTarget,
            taint: TurnTaint::Clean,
        },
    )
}
