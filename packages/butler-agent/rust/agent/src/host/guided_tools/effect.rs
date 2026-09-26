//! Work-bound persistent command dispatch. Effects owns admission and durable replay.

mod authority;
mod automation;
mod ledger;
mod ledger_input;
mod ledger_legacy;
mod mcp;
mod restart;
mod session_worktree;
mod topic_conversation;

pub(super) fn is_managed_project_ledger_effect(name: &str) -> bool {
    ledger_input::managed(name)
}

use serde_json::{Value, json};

use crate::btcc::{
    AccessMode, BtccError, EffectAccess, EffectOutcome, ExecuteEffect, GuidedInvocation,
    ModelRoundToolCall, ToolExecutionError,
};
use crate::host::guided_command::CommandScope;
use crate::json::{JsonDocument, visit_raw_object};

use super::NativeGuidedTools;

pub(super) async fn execute(
    owner: &NativeGuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let scope = CommandScope {
        workspace_reference: owner.binding.workspace_reference.as_ref(),
        workspace_path: &owner.binding.workspace_path,
        butler_data: &owner.binding.butler_data,
        access_mode: owner.binding.access_mode.clone(),
        abort: invocation.cancellation.clone(),
        allowed_tools_and_effects: owner.binding.allowed_tools_and_effects.as_deref(),
        installation_root: owner.binding.installation_root.as_deref(),
    };
    if call.name == "run_command"
        && !matches!(
            call.arguments.get("state_effect").and_then(Value::as_str),
            Some("mutation" | "remote_observation")
        )
    {
        return match owner
            .command
            .execute_observation(&call.arguments, scope)
            .await
        {
            Ok(result) => Ok(result),
            Err(error) => ordinary(error.code(), error.message(), None),
        };
    }
    if owner.binding.access_mode == AccessMode::ReadOnly {
        return ordinary(
            "read_only",
            "This Turn has read-only access; no change was applied.",
            None,
        );
    }
    if call.name == "bind_session_git_worktree"
        && (owner.binding.access_mode != AccessMode::FullAccess
            || owner.binding.project_id.is_none())
    {
        return ordinary(
            "session_workspace_unavailable",
            "An explicit project Turn with full access is required.",
            None,
        );
    }
    if call.name == "request_service_restart" && owner.binding.access_mode != AccessMode::FullAccess
    {
        return ordinary(
            "restart_full_access_required",
            "A full-access App Turn is required to request a service restart.",
            None,
        );
    }
    let Some(work) = owner
        .work
        .bound_work()
        .await
        .map_err(ToolExecutionError::Integrity)?
    else {
        return ordinary(
            "effect_work_required",
            "Create concise Work, record its Plan Review, then retry this persistent effect.",
            None,
        );
    };
    let prepared = if session_worktree::supports(&call.name) {
        session_worktree::prepare(owner, &call.arguments)
    } else if mcp::supports(&call.name) {
        mcp::prepare(owner, &call.arguments).map(|prepared| (prepared.0, prepared.1, prepared.2))
    } else if automation::supports(&call.name) {
        automation::prepare(owner, call, occurrence)
    } else if topic_conversation::supports(&call.name) {
        topic_conversation::prepare(owner, call, occurrence)
    } else if call.name == "request_service_restart" {
        restart::prepare(owner, &call.arguments)
    } else if call.name == "run_command" {
        owner
            .command
            .prepare_effect(&call.arguments, scope)
            .await
            .map(|prepared| (prepared.target, prepared.input, prepared.adapter))
    } else if ledger_input::managed(&call.name) {
        ledger::prepare(owner, &call.name, &call.arguments).await
    } else {
        owner
            .file_effects
            .prepare(
                &call.name,
                &Value::Object(call.arguments.clone()),
                &work,
                occurrence,
                owner.effect_journal.as_ref(),
            )
            .await
            .map(|prepared| (prepared.target, prepared.input, prepared.adapter))
    };
    let (target, input, adapter) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => return ordinary(error.code(), error.message(), None),
    };
    let resumes_authority = owner.binding.authority_request_ref.is_some()
        && owner.binding.authority_source_call_id.as_deref() == Some(occurrence)
        && !*owner.authority_consumed.lock();
    let approved = if owner.binding.access_mode == AccessMode::AskFirst || resumes_authority {
        match authority::gate(
            owner,
            call,
            occurrence,
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
    let outcome = owner
        .effects
        .execute(ExecuteEffect {
            work,
            access: EffectAccess::Full,
            occurrence_id: Some(occurrence.to_owned()),
            signal: invocation.cancellation.clone(),
            target,
            input,
            adapter,
        })
        .await
        .map_err(|error| ToolExecutionError::Integrity(error.into()))?;
    if let Some(approved) = approved
        && let Some(feedback) = authority::settle(owner, approved, &outcome).await?
    {
        return Ok(feedback);
    }
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
        EffectOutcome::Rejected(error) => ordinary(&error.code, &error.message, Some("rejected")),
        EffectOutcome::Failed(error) => ordinary(&error.code, &error.message, Some("failed")),
        EffectOutcome::Uncertain { error, .. } => {
            ordinary(&error.code, &error.message, Some("uncertain"))
        }
    }
}

fn ordinary(
    code: &str,
    message: &str,
    status: Option<&str>,
) -> Result<JsonDocument, ToolExecutionError> {
    let mut value = json!({"ok":false,"error":{"code":code,"message":message}});
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
    let receipt = crate::json::stringify(receipt).map_err(wire_error)?;
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

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn wire_error(error: crate::json::JsonError) -> ToolExecutionError {
    ToolExecutionError::Integrity(BtccError::relayed(
        "guided_tool_result_json",
        error.to_string(),
    ))
}
