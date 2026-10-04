//! File observations use the same durable decision and parent-conversation lane.
use super::{GuidedTools, encoded, file_capability};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{
    AccessMode, AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityExecutionInput,
    AuthorityOutcomeInput, BtccError, ModelRoundToolCall, RequestDecision, ToolExecutionError,
};
use serde_json::{Value, json};
use std::path::Path;

pub(super) async fn execute(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let args = normalized(owner, call)?;
    let approval = if owner.binding.access_mode == AccessMode::AskFirst {
        match gate(owner, call, occurrence, &args).await? {
            Gate::Pending(result) => return encoded(&result),
            Gate::Allowed(reference) => reference,
        }
    } else {
        None
    };
    let result = file_capability(owner, call, &args).await;
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

enum Gate {
    Pending(Value),
    Allowed(Option<String>),
}

async fn gate(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
    args: &Value,
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
    let admitted = owner
        .authority
        .admit(AuthorityAdmissionInput {
            owner_session_id: owner.binding.owner_session_id.clone(),
            source_session_id: owner.binding.source_session_id.clone(),
            source_turn_id: owner.binding.turn_id.clone(),
            operation_occurrence_id: Some(occurrence.into()),
            source_work_id: String::new(),
            workspace_path: owner.binding.workspace_path.to_string_lossy().into_owned(),
            plan_revision_id: String::new(),
            action_key: occurrence.into(),
            authority_generation: 1,
            capability: call.name.clone(),
            target: format!("file-observation:{occurrence}"),
            normalized_input: args.clone(),
            model_ref: owner.binding.model_ref.clone(),
            reasoning_effort: owner.binding.reasoning_effort.clone(),
            category: Some("file_observation".into()),
            public_action_title: Some(call.name.clone()),
        })
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
    })
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
    let absolute = |path: &str| {
        let path = Path::new(path);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            workspace.join(path)
        }
        .to_string_lossy()
        .into_owned()
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
