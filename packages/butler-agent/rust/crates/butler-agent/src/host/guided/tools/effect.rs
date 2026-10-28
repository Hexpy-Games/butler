//! Work-bound persistent command dispatch. Effects owns admission and durable replay.

mod authority;
mod automation;
mod ledger;
mod ledger_input;
mod mcp;
mod observation;
mod restart;
pub(super) mod runtime_work;
pub(super) mod session_folder;
mod session_worktree;
mod topic_conversation;
mod wallpaper;

pub(super) fn is_managed_project_ledger_effect(name: &str) -> bool {
    ledger_input::managed(name)
}

/// Host-managed effects routed before direct adapters, independently of their access kind.
pub(super) fn routes_effect(name: &str) -> bool {
    ledger_input::managed(name) || name == ToolName::SwitchFolder
}

use std::sync::Arc;

use butler_core::tool_protocol::ToolName;
use serde_json::{Value, json};

use crate::host::guided::command::CommandScope;
use butler_core::json::{JsonDocument, visit_raw_object};
use butler_turn::btcc::{
    AccessMode, BtccError, EffectAccess, EffectAdapter, EffectOutcome, ExecuteEffect,
    GuidedInvocation, ModelRoundToolCall, ToolExecutionError, WorkView,
};

use super::GuidedTools;

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    // A command that adds a worktree moves the session into it afterwards.
    let worktree_snapshot = if call.name == ToolName::RunCommand
        && session_folder::adds_worktree(
            call.arguments
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) {
        match session_folder::command_directory(owner, &call.arguments) {
            Some(cwd) => session_folder::worktrees(owner, &cwd)
                .await
                .map(|before| (cwd, before)),
            None => None,
        }
    } else {
        None
    };
    let result = Box::pin(execute_effect(owner, invocation, call, occurrence)).await?;
    Ok(match worktree_snapshot {
        Some(snapshot) => {
            session_folder::follow_new_worktree(owner, &invocation, call, snapshot, result).await
        }
        None => result,
    })
}

async fn execute_effect(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let scope = command_scope(owner, invocation.cancellation.clone());
    if let Some(result) = observation::execute(owner, call, occurrence, &scope).await? {
        return Ok(result);
    }
    // One decision per call, from the exact requested targets. The adapters
    // re-check containment when the targets are touched.
    let kind = super::access::gated_kind(owner, call).await?;
    let access =
        super::access::decision_for_kind(owner, call, &Value::Object(call.arguments.clone()), kind)
            .await
            .map_err(ToolExecutionError::Integrity)?;
    let decision = access.decision;
    if let Some(refusal) = admission_refusal(owner, call, decision).await? {
        return Ok(refusal);
    }
    let work = owner
        .work
        .bound_work()
        .await
        .map_err(ToolExecutionError::Integrity)?
        .unwrap_or_else(|| runtime_work::untracked(owner));
    let contained = contained_run(owner, occurrence, decision, kind);
    let prepared = prepare(owner, call, occurrence, (scope, contained), &work).await;
    let (target, input, adapter) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => return ordinary(error.code(), error.message(), None),
    };
    Box::pin(execute_prepared(
        owner,
        invocation,
        call,
        (occurrence, decision, access.unsandboxed),
        work,
        (target, input, adapter),
    ))
    .await
}

/// How an approval-free call outside full access runs: file effects re-check
/// project containment at use, and an Auto mutation runs in the
/// project-write sandbox when the decision allowed it because of that sandbox.
#[derive(Clone, Copy, Default)]
struct Contained {
    files: bool,
    project_write: bool,
}

fn contained_run(
    owner: &GuidedTools,
    occurrence: &str,
    decision: butler_turn::btcc::AccessDecision,
    kind: butler_turn::btcc::CapabilityKind,
) -> Contained {
    let mode = &owner.binding.access_mode;
    if decision != butler_turn::btcc::AccessDecision::Allow
        || *mode == AccessMode::FullAccess
        || super::access::resumes(owner, occurrence)
    {
        return Contained::default();
    }
    Contained {
        files: true,
        project_write: *mode == AccessMode::Auto
            && kind
                == (butler_turn::btcc::CapabilityKind::CommandMutation {
                    sandbox: butler_turn::btcc::CommandSandbox::ProjectWrite,
                }),
    }
}

/// Approval and journal dispatch share the prepared exact operation.
async fn execute_prepared(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    (occurrence, decision, unsandboxed): (&str, butler_turn::btcc::AccessDecision, bool),
    work: WorkView,
    prepared: (String, Value, Arc<dyn EffectAdapter>),
) -> Result<JsonDocument, ToolExecutionError> {
    let (target, input, adapter) = prepared;
    let resumes_authority = super::access::resumes(owner, occurrence);
    let approved =
        if matches!(decision, butler_turn::btcc::AccessDecision::Ask(_)) || resumes_authority {
            match authority::gate(
                owner,
                call,
                (occurrence, decision, unsandboxed),
                &work,
                &target,
                &input,
                adapter.as_ref(),
            )
            .await?
            {
                authority::Gate::Return(result) => return Ok(result),
                authority::Gate::Execute(approved) => approved,
            }
        } else {
            None
        };
    let outcome = match owner
        .effects
        .execute(ExecuteEffect {
            work,
            access: EffectAccess::Full,
            occurrence_id: Some(occurrence.to_owned()),
            signal: invocation.cancellation.clone(),
            target: target.clone(),
            input,
            adapter: adapter.clone(),
        })
        .await
    {
        Ok(outcome) => outcome,
        Err(error) if super::feedback::solvable(error.code()) => {
            return contract_feedback(error.code(), error.message(), adapter.capability(), &target);
        }
        Err(error) => return Err(ToolExecutionError::Integrity(error.into())),
    };
    if let Some(approved) = approved
        && let Some(feedback) = authority::settle(owner, approved, &outcome).await?
    {
        return Ok(feedback);
    }
    outcome_result(outcome, adapter.capability(), &target)
}

/// The target, input and adapter of the persistent effect `call` asks for.
async fn prepare(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
    (scope, contained): (CommandScope<'_>, Contained),
    work: &WorkView,
) -> Result<(String, Value, Arc<dyn EffectAdapter>), BtccError> {
    if session_worktree::supports(&call.name) {
        session_worktree::prepare(owner, &call.arguments)
    } else if call.name == ToolName::SwitchFolder {
        session_folder::prepare(owner, &call.arguments).await
    } else if mcp::supports(&call.name) {
        mcp::prepare(owner, &call.arguments).map(|prepared| (prepared.0, prepared.1, prepared.2))
    } else if automation::supports(&call.name) {
        automation::prepare(owner, call, occurrence).await
    } else if topic_conversation::supports(&call.name) {
        topic_conversation::prepare(owner, call, occurrence)
    } else if call.name == ToolName::RequestServiceRestart {
        restart::prepare(owner, &call.arguments)
    } else if wallpaper::supports(&call.name) {
        wallpaper::prepare(owner, call)
    } else if call.name == ToolName::RunCommand {
        owner
            .command
            .prepare_effect(&call.arguments, scope, contained.project_write)
            .await
            .map(|prepared| (prepared.target, prepared.input, prepared.adapter))
    } else if ledger_input::managed(&call.name) {
        ledger::prepare(owner, &call.name, &call.arguments).await
    } else {
        let contained_effects;
        let effects = if contained.files {
            contained_effects = owner.file_effects.contained();
            &contained_effects
        } else {
            &owner.file_effects
        };
        effects
            .prepare(
                &call.name,
                &Value::Object(call.arguments.clone()),
                work,
                occurrence,
                owner.effect_journal.as_ref(),
            )
            .await
            .map(|prepared| (prepared.target, prepared.input, prepared.adapter))
    }
}

fn ordinary(
    code: &str,
    message: &str,
    status: Option<&str>,
) -> Result<JsonDocument, ToolExecutionError> {
    let mut value = json!({"ok":false,"error":{"code":code,"message":message}});
    if super::feedback::solvable(code) {
        value["error"]["recoverable"] = true.into();
        value["error"]["next_action"] = super::feedback::repair(code).into();
    }
    if let Some(status) = status {
        value["error"]["effect_status"] = status.into();
    }
    JsonDocument::from_value(&value).map_err(wire_error)
}

/// Append the small public receipt while forwarding each result value verbatim.
fn receipt_result(
    result: &JsonDocument,
    receipt: &Value,
) -> Result<JsonDocument, ToolExecutionError> {
    let receipt = butler_core::json::stringify(receipt).map_err(wire_error)?;
    let raw = result.as_str().trim_start();
    let encoded = if raw.starts_with('{') {
        let mut encoded = String::with_capacity(raw.len() + receipt.len() + 32);
        encoded.push('{');
        let mut replaced = false;
        visit_raw_object(raw, |key, value| {
            if encoded.len() > 1 {
                encoded.push(',');
            }
            encoded.push_str(key);
            encoded.push(':');
            if serde_json::from_str::<String>(key).ok().as_deref() == Some("effect_receipt") {
                encoded.push_str(&receipt);
                replaced = true;
            } else {
                encoded.push_str(value);
            }
            Ok(())
        })
        .map_err(wire_error)?;
        if !replaced {
            if encoded.len() > 1 {
                encoded.push(',');
            }
            encoded.push_str("\"effect_receipt\":");
            encoded.push_str(&receipt);
        }
        encoded.push('}');
        encoded
    } else {
        format!("{{\"ok\":true,\"result\":{raw},\"effect_receipt\":{receipt}}}")
    };
    JsonDocument::from_encoded(encoded).map_err(wire_error)
}

pub(super) fn wire_error(error: butler_core::json::JsonError) -> ToolExecutionError {
    ToolExecutionError::Integrity(
        BtccError::relayed("guided_tool_result_json", error.to_string()).with_source(error),
    )
}

fn outcome_result(
    outcome: EffectOutcome,
    capability: &str,
    target: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    match outcome {
        EffectOutcome::Applied {
            result,
            receipt,
            replayed,
        } => {
            let mut public = json!({
                "receipt_id":receipt.receipt_id, "capability":receipt.capability,
                "target":receipt.sanitized_target, "applied_at":receipt.applied_at,
                "replayed":replayed,
            });
            if let Some(line) = result
                .field("start_line")
                .map_err(wire_error)?
                .and_then(|raw| serde_json::from_str::<serde_json::Number>(raw).ok())
            {
                public["start_line"] = Value::Number(line);
            }
            receipt_result(&result, &public)
        }
        EffectOutcome::Rejected(error) if super::feedback::solvable(&error.code) => {
            contract_feedback(&error.code, &error.message, capability, target)
        }
        EffectOutcome::Rejected(error) => ordinary(&error.code, &error.message, Some("rejected")),
        EffectOutcome::Failed(error) => ordinary(&error.code, &error.message, Some("failed")),
        EffectOutcome::Uncertain { error, .. } => {
            ordinary(&error.code, &error.message, Some("uncertain"))
        }
    }
}

fn contract_feedback(
    code: &str,
    message: &str,
    capability: &str,
    target: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let mut value = json!({"ok":false,"error":{"code":code,"message":message,
        "recoverable":true,"next_action":super::feedback::repair(code),
        "required_effect":{"capability":capability,"target":target}}});
    value["error"]["effect_status"] = "rejected".into();
    JsonDocument::from_value(&value).map_err(wire_error)
}

/// Mode refusal and unattended attention are settled before preparing any effect.
async fn admission_refusal(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    decision: butler_turn::btcc::AccessDecision,
) -> Result<Option<JsonDocument>, ToolExecutionError> {
    if matches!(decision, butler_turn::btcc::AccessDecision::Deny(_)) && owner.unattended() {
        return super::turn_guard::unattended_denial(owner, call)
            .await
            .map(Some);
    }
    if decision == butler_turn::btcc::AccessDecision::Deny(butler_turn::btcc::DenyReason::ReadOnly)
    {
        return ordinary(
            "read_only",
            "This Turn has read-only access; no change was applied.",
            None,
        )
        .map(Some);
    }
    if call.name == ToolName::BindSessionGitWorktree
        && (matches!(decision, butler_turn::btcc::AccessDecision::Deny(_))
            || owner.binding.project_id.is_none())
    {
        return ordinary(
            "session_workspace_unavailable",
            "An explicit project Turn with full access is required.",
            None,
        )
        .map(Some);
    }
    if call.name == ToolName::RequestServiceRestart
        && matches!(decision, butler_turn::btcc::AccessDecision::Deny(_))
    {
        return ordinary(
            "restart_full_access_required",
            "A full-access App Turn is required to request a service restart.",
            None,
        )
        .map(Some);
    }
    Ok(None)
}

fn command_scope(
    owner: &GuidedTools,
    signal: tokio_util::sync::CancellationToken,
) -> CommandScope<'_> {
    CommandScope {
        workspace_reference: owner.binding.workspace_reference.as_ref(),
        workspace_path: &owner.binding.workspace_path,
        butler_data: &owner.binding.butler_data,
        execution: if owner.binding.access_mode == AccessMode::FullAccess {
            crate::host::guided::command::CommandExecution::Registered
        } else {
            crate::host::guided::command::CommandExecution::Sandboxed
        },
        contained_reads: false,
        abort: signal,
        allowed_tools_and_effects: owner.binding.allowed_tools_and_effects.as_deref(),
        installation_root: owner.binding.installation_root.as_deref(),
        deny_secret_reads: owner.binding.access_mode != AccessMode::FullAccess,
    }
}

/// Denied effects still describe the exact operation prepared for a card.
pub(super) async fn attention_facts(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
) -> Result<(String, Value), BtccError> {
    let work = owner
        .work
        .bound_work()
        .await?
        .unwrap_or_else(|| runtime_work::untracked(owner));
    let occurrence =
        butler_turn::btcc::digest_identity(&Value::Object(call.arguments.clone()).to_string());
    let scope = command_scope(owner, tokio_util::sync::CancellationToken::new());
    let (target, input, adapter) = prepare(
        owner,
        call,
        &occurrence,
        (scope, Contained::default()),
        &work,
    )
    .await?;
    let target = adapter
        .normalize_target(&target)
        .map_err(|e| BtccError::relayed(e.code().to_owned(), e.message().to_owned()))?;
    let input = adapter
        .normalize_input(&input)
        .map_err(|e| BtccError::relayed(e.code().to_owned(), e.message().to_owned()))?;
    Ok((target, input))
}
