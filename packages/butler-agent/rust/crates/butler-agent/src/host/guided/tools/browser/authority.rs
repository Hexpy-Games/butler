//! Durable ask-first and hand-back waits use the existing #162 continuation lane.
use super::super::GuidedTools;
use butler_turn::btcc::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityExecutionInput, ModelRoundToolCall,
    RequestDecision, ToolExecutionError,
};
use serde_json::{Value, json};
pub(super) enum Gate {
    Pending(Value),
    Allowed(Option<String>),
}
pub(super) async fn gate(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
    input: &Value,
    target: &str,
) -> Result<Gate, ToolExecutionError> {
    if let Some(reference) = resume_reference(owner, occurrence) {
        let stored = owner
            .authority
            .execution(AuthorityExecutionInput {
                owner_session_id: owner.binding.owner_session_id.clone(),
                request_ref: reference.to_owned(),
                source_session_id: Some(owner.binding.source_session_id.clone()),
                client_message_id: None,
                turn_id: owner.binding.turn_id.clone(),
            })
            .await
            .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
        let belongs = stored.decision == RequestDecision::Allowed
            && stored.capability == call.name
            && stored.source_call_id.as_deref() == Some(occurrence);
        if !belongs || stored.normalized_input != *input || stored.normalized_target != target {
            if belongs {
                super::settle(owner, Some(reference.to_owned()), "unknown").await?;
            }
            return Ok(Gate::Pending(
                json!({"ok":false,"status":"unknown","observe_required":true,"error":"authority_request_identity_mismatch"}),
            ));
        }
        return Ok(Gate::Allowed(Some(reference.to_owned())));
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
            action_key: input
                .get("dialog")
                .and_then(|d| d.get("id"))
                .and_then(Value::as_str)
                .map_or_else(
                    || occurrence.into(),
                    |id| format!("{occurrence}:dialog:{id}"),
                ),
            authority_generation: 1,
            capability: call.name.clone(),
            target: target.into(),
            normalized_input: input.clone(),
            model_ref: owner.binding.model_ref.clone(),
            reasoning_effort: owner.binding.reasoning_effort.clone(),
            category: Some("reviewed_effect".into()),
            public_action_title: Some(call.name.clone()),
        })
        .await
        .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
    Ok(match admitted {
        AuthorityAdmissionResult::Granted => Gate::Allowed(None),
        AuthorityAdmissionResult::Pending { request_ref, .. }
        | AuthorityAdmissionResult::Allowed { request_ref, .. } => Gate::Pending(
            json!({"ok":true,"authority_pending":true,"request_ref":request_ref,"status":"awaiting_allow"}),
        ),
        _ => Gate::Pending(json!({"ok":false,"error":"authority_request_denied"})),
    })
}

pub(super) async fn act_gate(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
    input: &Value,
    target: &str,
) -> Result<Gate, ToolExecutionError> {
    if input["always_confirm"] == true
        || owner.binding.access_mode.reviews_effects()
        || owner.binding.authority_request_ref.is_some()
    {
        gate(owner, call, occurrence, input, target).await
    } else {
        Ok(Gate::Allowed(None))
    }
}

fn resume_reference<'a>(owner: &'a GuidedTools, occurrence: &str) -> Option<&'a str> {
    owner.binding.authority_request_ref.as_deref().filter(|_| {
        owner.binding.authority_source_call_id.as_deref() == Some(occurrence)
            && !*owner.authority_consumed.lock()
    })
}

/// Revalidation cannot prove whether a previous interrupted attempt dispatched.
/// Settle only this bound allowed source call, preserving that uncertainty.
pub(super) async fn refuse_resume(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<(), ToolExecutionError> {
    let Some(reference) = resume_reference(owner, occurrence) else {
        return Ok(());
    };
    let stored = owner
        .authority
        .execution(AuthorityExecutionInput {
            owner_session_id: owner.binding.owner_session_id.clone(),
            request_ref: reference.to_owned(),
            source_session_id: Some(owner.binding.source_session_id.clone()),
            client_message_id: None,
            turn_id: owner.binding.turn_id.clone(),
        })
        .await
        .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
    if stored.decision == RequestDecision::Allowed
        && stored.capability == call.name
        && stored.source_call_id.as_deref() == Some(occurrence)
    {
        super::settle(owner, Some(reference.to_owned()), "unknown").await?;
    }
    Ok(())
}
