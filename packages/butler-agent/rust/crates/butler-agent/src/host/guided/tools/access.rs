//! Admission decisions and blocking target classification for guided tools.
use super::GuidedTools;
use butler_core::tool_protocol::ToolName;
use butler_turn::btcc::{
    AccessDecision, AccessMode, AccessRequest, ApprovalRisk, BtccError, CapabilityKind,
    CommandSandbox, GrantUse, ModelRoundToolCall, TargetScope, ToolExecutionError,
    command_access_risk, command_scope_unresolved, decide, needs_scope,
};
use butler_turn::workspace::{FolderRelation, ScopeRoots, classify_targets};
use serde_json::Value;

pub(super) async fn kind(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
) -> Result<CapabilityKind, BtccError> {
    if call.name == "run_command" {
        // The first probe spawns a helper and waits for it. Cache it from a
        // blocking worker before synchronous classification touches it.
        tokio::task::spawn_blocking(butler_platform::command_sandbox::capabilities)
            .await
            .map_err(|error| BtccError::relayed("sandbox_probe_failed", error.to_string()))?;
    }
    let mut kind = CapabilityKind::of_call(
        &call.name,
        &call.arguments,
        super::effect::is_managed_project_ledger_effect(&call.name),
    );
    if owner.binding.access_mode == AccessMode::Auto
        && matches!(
            kind,
            CapabilityKind::CommandMutation { .. }
                | CapabilityKind::CommandObservation { sandboxed: false }
        )
        && sandbox_enabled(owner).await != Some(true)
    {
        kind = CapabilityKind::CommandMutation {
            sandbox: butler_turn::btcc::CommandSandbox::Disabled,
        };
    }
    Ok(kind)
}

pub(super) async fn sandbox_enabled(owner: &GuidedTools) -> Option<bool> {
    let path = owner.monitoring.app_database_path.clone();
    butler_gateway::gateway::command_sandbox_enabled(path)
        .await
        .ok()
}

pub(super) async fn gated_kind(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
) -> Result<CapabilityKind, ToolExecutionError> {
    Ok(kind(owner, call)
        .await
        .map_err(ToolExecutionError::Integrity)?
        .gated_effect())
}

/// Keep the filesystem classification used for admission through execution.
pub(super) struct ClassifiedAccess {
    pub decision: AccessDecision,
    pub scope: TargetScope,
    /// The command would run with the user's access while its secret reads
    /// stay open; its fresh approval says so ([`unsandboxed`]).
    pub unsandboxed: bool,
}

pub(super) async fn decision(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    args: &Value,
) -> Result<ClassifiedAccess, BtccError> {
    decision_for_kind(owner, call, args, kind(owner, call).await?).await
}
pub(super) async fn decision_for_kind(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    args: &Value,
    kind: CapabilityKind,
) -> Result<ClassifiedAccess, BtccError> {
    let scope = if needs_scope(&owner.binding.access_mode, kind) {
        target_scope(owner, call, args).await?
    } else {
        TargetScope::NoTarget
    };
    let mode = &owner.binding.access_mode;
    let mut decision = decide(
        mode,
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
    );
    if matches!(
        call.name.as_str(),
        "create_automation" | "update_automation"
    ) && owner.taint() == butler_turn::btcc::TurnTaint::External
        && ["browser_signin", "browser_payment"]
            .iter()
            .any(|key| args[*key] == true)
        && !matches!(decision, AccessDecision::Deny(_))
    {
        decision = AccessDecision::Ask(GrantUse::Ignore);
    }
    let unsandboxed = call.name == ToolName::RunCommand && unsandboxed(mode, kind, decision, args);
    Ok(ClassifiedAccess {
        decision: if unsandboxed {
            AccessDecision::Ask(GrantUse::Ignore)
        } else {
            decision
        },
        scope,
        unsandboxed,
    })
}

/// The approval card reason of an [`unsandboxed`] command.
pub(super) const UNSANDBOXED_REASON: &str = "authority.unsandboxedReason";

/// Whether a command would run with the user's access while the kernel
/// leaves Butler's secrets and credential stores readable: it opted out with
/// `sandbox: "none"`, or this host cannot deny those reads and the lexical
/// guard cannot resolve what the command names. It then always asks, with a
/// card that says so, and a standing permission never covers it. Full
/// Access stays best-effort by the owner's choice.
fn unsandboxed(
    mode: &AccessMode,
    kind: CapabilityKind,
    decision: AccessDecision,
    args: &Value,
) -> bool {
    if *mode == AccessMode::FullAccess || matches!(decision, AccessDecision::Deny(_)) {
        return false;
    }
    let uncontained = match kind {
        CapabilityKind::CommandObservation { sandboxed: false } => mode.reviews_effects(),
        CapabilityKind::CommandMutation { sandbox } => {
            !(decision == AccessDecision::Allow
                && *mode == AccessMode::Auto
                && sandbox == CommandSandbox::ProjectWrite)
        }
        CapabilityKind::Network => true,
        _ => false,
    };
    let opted_out = args["sandbox"].as_str() == Some("none");
    uncontained
        && (opted_out
            || !butler_platform::command_sandbox::secret_reads_deniable()
                && command_scope_unresolved(args["command"].as_str().unwrap_or("")))
}
async fn target_scope(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    args: &Value,
) -> Result<TargetScope, BtccError> {
    if call.name == ToolName::SwitchFolder {
        return Ok(folder_scope(owner, args).await);
    }
    let consented = owner.folder_consented();
    let root = owner.current_workspace()?;
    let project = consented.then(|| root.clone());
    let data = owner.binding.butler_data.clone();
    let protected = owner.binding.protected_ledger_roots.clone();
    let attachments = owner.binding.attachment_files.clone();
    let installation = owner.binding.installation_root.clone();
    let args = args.clone();
    let name = call.name.clone();
    tokio::task::spawn_blocking(move || {
        let roots = ScopeRoots {
            attachments: &attachments,
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
/// A folder switch stays in scope within a consented folder or its
/// repository; a refused folder is outside (its preparation reports why).
async fn folder_scope(owner: &GuidedTools, args: &Value) -> TargetScope {
    let contained = super::effect::session_folder::relation(owner, args)
        .await
        .is_some_and(FolderRelation::contained);
    if contained && owner.folder_consented() {
        TargetScope::ProjectFolder
    } else {
        TargetScope::Outside
    }
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

/// Explain effective project-write availability without disabling run_command:
/// explicit approval and the other permission tiers remain usable.
pub(super) async fn sandbox_report(owner: &GuidedTools) -> Result<Value, BtccError> {
    let setting = sandbox_enabled(owner).await;
    let enabled = setting == Some(true);
    let caps = tokio::task::spawn_blocking(butler_platform::command_sandbox::capabilities)
        .await
        .map_err(|error| BtccError::relayed("sandbox_probe_failed", error.to_string()))?;
    let reason = if setting.is_none() {
        Some("settings_unavailable")
    } else if !enabled {
        Some("disabled_by_user")
    } else if !caps.project_write_available() {
        match caps.project_write {
            butler_platform::command_sandbox::Level::Unavailable(reason) => Some(reason),
            _ => Some("sandbox_unavailable"),
        }
    } else {
        None
    };
    Ok(
        serde_json::json!({"enabled":enabled, "available":caps.project_write_available(),
        "project_write":enabled && caps.project_write_available(), "disabled_reason":reason,
        "when_unavailable":"Auto project-write commands require approval."}),
    )
}
