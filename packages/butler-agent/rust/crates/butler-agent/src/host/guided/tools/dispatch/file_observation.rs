//! File observations use the same durable decision and parent-conversation lane.
use super::{GuidedTools, encoded, file_capability};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityExecutionInput,
    AuthorityOutcomeInput, BtccError, ModelRoundToolCall, RequestDecision, ToolExecutionError,
};
use serde_json::{Value, json};

pub(super) async fn execute(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let args = normalized(owner, call)?;
    let access = super::super::access::decision(owner, call, &args)
        .await
        .map_err(ToolExecutionError::Integrity)?;
    let args = if access.scope == butler_turn::btcc::TargetScope::Attachment {
        // Classification proved these lexical absolute paths equal the stored
        // attachment paths. Execute those same paths, never a resolved alias.
        args
    } else {
        let resolved = super::link_targets::resolve_paths(owner, call)
            .await
            .map_err(ToolExecutionError::Integrity)?;
        normalized(owner, resolved.as_ref().unwrap_or(call))?
    };
    let gated = matches!(access.decision, butler_turn::btcc::AccessDecision::Ask(_))
        || super::super::access::resumes(owner, occurrence);
    let approval = if gated {
        match gate(owner, call, occurrence, &args, access.unsandboxed).await? {
            Gate::Pending(result) => return encoded(&result),
            Gate::Allowed(reference) => reference,
        }
    } else {
        None
    };
    let result = file_capability(
        owner,
        call,
        &args,
        !gated
            && owner.binding.access_mode.reviews_effects()
            && access.scope != butler_turn::btcc::TargetScope::Attachment,
    )
    .await;
    if gated {
        // An approved read reached beyond the project: external content (D5).
        owner.mark_external();
    }
    if let Some(request_ref) = approval {
        owner
            .authority
            .record_outcome(AuthorityOutcomeInput {
                request_ref,
                owner_session_id: owner.binding.owner_session_id.clone(),
                source_work_id: String::new(),
                status: if result.as_ref().is_ok_and(|v| v["ok"] == true) {
                    "applied"
                } else {
                    "failed"
                }
                .into(),
                receipt: None,
            })
            .await
            .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
        *owner.authority_consumed.lock() = true;
    }
    encoded(&result.map_err(ToolExecutionError::Integrity)?)
}

pub(in crate::host::guided::tools) enum Gate {
    Pending(Value),
    Allowed(Option<String>),
}

pub(in crate::host::guided::tools) async fn gate(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
    args: &Value,
    unsandboxed: bool,
) -> Result<Gate, ToolExecutionError> {
    let resume = owner.binding.authority_request_ref.as_ref().filter(|_| {
        owner.binding.authority_source_call_id.as_deref() == Some(occurrence)
            && !*owner.authority_consumed.lock()
    });
    if let Some(reference) = resume {
        let stored = owner
            .authority
            .execution(AuthorityExecutionInput {
                owner_session_id: owner.binding.owner_session_id.clone(),
                request_ref: reference.clone(),
                source_session_id: Some(owner.binding.source_session_id.clone()),
                client_message_id: None,
                turn_id: owner.binding.turn_id.clone(),
            })
            .await
            .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
        if stored.decision != RequestDecision::Allowed
            || !stored.source_work_id.is_empty()
            || !stored.plan_revision_id.is_empty()
            || stored.capability != call.name.as_str()
            || stored.normalized_input != *args
            || stored.source_call_id.as_deref() != Some(occurrence)
        {
            return Ok(Gate::Pending(
                json!({"ok":false,"error":"authority_request_identity_mismatch"}),
            ));
        }
        return Ok(Gate::Allowed(Some(reference.clone())));
    }
    let admitted = super::super::attention::admit(
        owner,
        AuthorityAdmissionInput {
            owner_session_id: owner.binding.owner_session_id.clone(),
            source_session_id: owner.binding.source_session_id.clone(),
            source_turn_id: owner.binding.turn_id.clone(),
            operation_occurrence_id: Some(occurrence.into()),
            source_work_id: String::new(),
            workspace_path: owner.active_workspace_path().to_string_lossy().into_owned(),
            plan_revision_id: String::new(),
            action_key: occurrence.into(),
            authority_generation: 1,
            capability: call.name.clone(),
            target: request_target(call, args),
            normalized_input: args.clone(),
            model_ref: owner.binding.model_ref.clone(),
            reasoning_effort: owner.binding.reasoning_effort.clone(),
            category: Some(category(call).into()),
            public_action_title: Some(approval_reason(call, unsandboxed)),
            honor_standing_permission: !unsandboxed
                && !matches!(call.name.as_str(), "web_read" | "web_search"),
            unattended: owner.unattended(),
        },
    )
    .await
    .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
    Ok(match admitted {
        AuthorityAdmissionResult::Granted => Gate::Allowed(None),
        AuthorityAdmissionResult::Pending { request_ref, .. }
        | AuthorityAdmissionResult::Allowed { request_ref, .. } => Gate::Pending(json!({
            "ok":true,"authority_pending":true,"request_ref":request_ref,"status":"awaiting_allow"})),
        AuthorityAdmissionResult::Denied { .. } => {
            Gate::Pending(json!({"ok":false,"error":"authority_request_denied"}))
        }
        AuthorityAdmissionResult::Modified { .. } => {
            Gate::Pending(json!({"ok":false,"error":"authority_request_modified"}))
        }
        AuthorityAdmissionResult::Unattended => Gate::Pending(
            super::super::turn_guard::unattended_feedback(owner, &call.name, &observed(call, args)),
        ),
    })
}

fn category(call: &ModelRoundToolCall) -> &'static str {
    if matches!(call.name.as_str(), "web_read" | "web_search") {
        "reviewed_effect"
    } else if call.name == "run_command" {
        "command_observation"
    } else {
        "file_observation"
    }
}

/// What an observation reads, for an unattended run's report.
fn observed(call: &ModelRoundToolCall, args: &Value) -> String {
    let paths: Vec<&str> = if matches!(call.name.as_str(), "web_read" | "web_search") {
        args[if call.name == "web_read" {
            "url"
        } else {
            "query"
        }]
        .as_str()
        .into_iter()
        .collect()
    } else if call.name == "run_command" {
        args["command"]
            .as_str()
            .and_then(|command| command.split_whitespace().next())
            .into_iter()
            .collect()
    } else if call.name == "read_file" {
        args["requests"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|request| request["path"].as_str())
            .collect()
    } else {
        args["root"].as_str().into_iter().collect()
    };
    paths.join(", ")
}

fn normalized(owner: &GuidedTools, call: &ModelRoundToolCall) -> Result<Value, ToolExecutionError> {
    let workspace = owner
        .binding
        .workspace_reference
        .as_ref()
        .map(butler_turn::workspace::WorkspaceReference::get)
        .transpose()
        .map_err(|e| {
            ToolExecutionError::Integrity(BtccError::relayed(e.code(), "Workspace unavailable"))
        })?
        .unwrap_or_else(|| owner.binding.workspace_path.clone());
    let absolute = |path: &str| -> String {
        butler_platform::tool_paths::resolve(&workspace, path)
            .map(|target| target.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_owned())
    };
    let mut args = Value::Object(call.arguments.clone());
    if call.name == "read_file" {
        if let Some(requests) = args["requests"].as_array_mut() {
            for request in requests {
                if let Some(path) = request["path"].as_str() {
                    request["path"] = json!(absolute(path));
                }
            }
        }
    } else {
        args["root"] = json!(absolute(args["root"].as_str().unwrap_or(".")));
    }
    Ok(args)
}

fn request_target(call: &ModelRoundToolCall, args: &Value) -> String {
    if matches!(call.name.as_str(), "web_read" | "web_search") {
        observed(call, args)
    } else {
        format!("observation:{}", call.name)
    }
}
fn approval_reason(call: &ModelRoundToolCall, unsandboxed: bool) -> String {
    if unsandboxed {
        super::super::access::UNSANDBOXED_REASON.into()
    } else if matches!(call.name.as_str(), "web_read" | "web_search") {
        "authority.taintReason".into()
    } else {
        call.name.clone()
    }
}
