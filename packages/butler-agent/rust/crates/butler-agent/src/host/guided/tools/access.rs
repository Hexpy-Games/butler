//! Admission decisions and blocking target classification for guided tools.
use super::GuidedTools;
use butler_turn::btcc::{
    AccessDecision, AccessRequest, ApprovalRisk, BtccError, CapabilityKind, ModelRoundToolCall,
    TargetScope, ToolExecutionError, command_access_risk, command_scope_unresolved, decide,
    needs_scope,
};
use butler_turn::workspace::{ScopeRoots, classify_targets};
use serde_json::Value;

pub(super) async fn kind(call: &ModelRoundToolCall) -> Result<CapabilityKind, BtccError> {
    if call.name == "run_command" {
        // The first probe spawns a helper and waits for it. Cache it from a
        // blocking worker before synchronous classification touches it.
        tokio::task::spawn_blocking(butler_platform::command_sandbox::capabilities)
            .await
            .map_err(|error| BtccError::relayed("sandbox_probe_failed", error.to_string()))?;
    }
    Ok(CapabilityKind::of_call(
        &call.name,
        &call.arguments,
        super::effect::is_managed_project_ledger_effect(&call.name),
    ))
}
pub(super) async fn gated_kind(
    call: &ModelRoundToolCall,
) -> Result<CapabilityKind, ToolExecutionError> {
    Ok(kind(call)
        .await
        .map_err(ToolExecutionError::Integrity)?
        .gated_effect())
}

pub(super) async fn decision(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    args: &Value,
) -> Result<AccessDecision, BtccError> {
    decision_for_kind(owner, call, args, kind(call).await?).await
}
pub(super) async fn decision_for_kind(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    args: &Value,
    kind: CapabilityKind,
) -> Result<AccessDecision, BtccError> {
    let scope = if needs_scope(&owner.binding.access_mode, kind) {
        target_scope(owner, call, args).await?
    } else {
        TargetScope::NoTarget
    };
    Ok(decide(
        &owner.binding.access_mode,
        AccessRequest {
            kind,
            risk: if call.name == "run_command" {
                command_access_risk(args["command"].as_str().unwrap_or(""))
            } else {
                ApprovalRisk::Medium
            },
            scope,
            taint: owner.taint(),
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
        .map(butler_turn::workspace::WorkspaceReference::get)
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
            let Ok(cwd) =
                butler_platform::tool_paths::parse(&root, args["cwd"].as_str().unwrap_or("."))
            else {
                return TargetScope::Outside;
            };
            let cwd = root.join(cwd);
            let mut targets = vec![cwd.to_string_lossy().into_owned()];
            targets.extend(
                butler_platform::command_sandbox::path_tokens(command)
                    .into_iter()
                    .filter(|token| !token.starts_with('-'))
                    .map(butler_platform::command_sandbox::normalize_path_token),
            );
            classify_targets(
                &roots,
                &cwd,
                &targets.iter().map(String::as_str).collect::<Vec<_>>(),
            )
        } else {
            let paths = |list: &str| -> Vec<&str> {
                args[list]
                    .as_array()
                    .map(|items| items.iter().filter_map(|r| r["path"].as_str()).collect())
                    .unwrap_or_default()
            };
            let targets = match name.as_str() {
                "read_file" => paths("requests"),
                // A missing path cannot be proven inside the project.
                "write_file" | "edit_file" => {
                    let mut targets = paths("edits");
                    targets.extend(args["path"].as_str());
                    if targets.is_empty() {
                        return TargetScope::Outside;
                    }
                    targets
                }
                _ => vec![args["root"].as_str().unwrap_or(".")],
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
            taint: owner.taint(),
        },
    )
}
