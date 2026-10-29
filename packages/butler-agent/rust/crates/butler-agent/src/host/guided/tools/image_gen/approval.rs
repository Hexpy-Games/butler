use super::*;
use butler_turn::btcc::{
    AccessDecision, AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityExecutionInput,
    AuthorityOutcomeInput, CapabilityKind, RequestDecision,
};
pub(super) enum Gate {
    Return(Value),
    Allowed(Option<String>),
}
pub(super) async fn gate(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    facts: &Value,
) -> Result<Gate, ToolExecutionError> {
    if let Some(reference) = owner
        .binding
        .authority_request_ref
        .as_ref()
        .filter(|_| super::super::access::resumes(owner, occurrence))
    {
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
        return Ok(
            if stored.decision == RequestDecision::Allowed
                && stored.capability == call.name
                && stored.source_call_id.as_deref() == Some(occurrence)
                && stored.normalized_input == *facts
            {
                Gate::Allowed(Some(reference.clone()))
            } else {
                Gate::Return(
                    json!({"ok":false,"error":{"code":"authority_request_identity_mismatch","message":"The image request changed."}}),
                )
            },
        );
    }
    if super::super::access::for_kind(owner, CapabilityKind::ImageModelCall)
        == AccessDecision::Allow
        || editor_grant(owner, invocation, call, occurrence).await?
    {
        return Ok(Gate::Allowed(None));
    }
    let input = admission(owner, call, occurrence, facts);
    let result = super::super::attention::admit(owner, input)
        .await
        .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
    Ok(match result {
        AuthorityAdmissionResult::Granted => Gate::Allowed(None),
        AuthorityAdmissionResult::Unattended => Gate::Return(
            super::super::turn_guard::unattended_feedback(owner, &call.name, &call.name),
        ),
        AuthorityAdmissionResult::Pending { request_ref, .. }
        | AuthorityAdmissionResult::Allowed { request_ref, .. } => Gate::Return(
            json!({"ok":true,"authority_pending":true,"request_ref":request_ref,"status":"awaiting_allow"}),
        ),
        AuthorityAdmissionResult::Denied { denial_text, .. } => Gate::Return(
            json!({"ok":false,"error":{"code":"authority_request_denied","message":denial_text}}),
        ),
        AuthorityAdmissionResult::Modified { .. } => Gate::Return(
            json!({"ok":false,"error":{"code":"authority_request_denied","message":"Image request not authorized."}}),
        ),
    })
}
async fn editor_grant(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<bool, ToolExecutionError> {
    let Some(grant) = invocation
        .turn
        .context
        .pointer("/messageContent/image_edit")
    else {
        return Ok(false);
    };
    let matches = |args: &Value| {
        args["image"] == grant["image"]
            && args.get("mask").filter(|v| !v.is_null())
                == grant.get("mask").filter(|v| !v.is_null())
    };
    if call.name != "edit_image" || !matches(&Value::Object(call.arguments.clone())) {
        return Ok(false);
    }
    let signatures = owner
        .journal
        .list_signatures(owner.binding.turn_id.clone())
        .await
        .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
    Ok(signatures
        .iter()
        .find(|s| s.tool_name == "edit_image" && matches(&s.arguments))
        .is_some_and(|s| s.call_id == occurrence))
}
pub(super) async fn settle(
    owner: &GuidedTools,
    reference: Option<String>,
    status: &str,
) -> Result<(), ToolExecutionError> {
    if let Some(request_ref) = reference {
        owner
            .authority
            .record_outcome(AuthorityOutcomeInput {
                request_ref,
                owner_session_id: owner.binding.owner_session_id.clone(),
                source_work_id: String::new(),
                status: status.into(),
                receipt: None,
            })
            .await
            .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
        *owner.authority_consumed.lock() = true;
    }
    Ok(())
}

fn admission(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
    facts: &Value,
) -> AuthorityAdmissionInput {
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
        target: facts["model_ref"].as_str().unwrap_or("").into(),
        normalized_input: facts.clone(),
        model_ref: owner.binding.model_ref.clone(),
        reasoning_effort: owner.binding.reasoning_effort.clone(),
        category: Some("reviewed_effect".into()),
        public_action_title: Some(call.name.clone()),
        honor_standing_permission: false,
        unattended: owner.unattended(),
    }
}
