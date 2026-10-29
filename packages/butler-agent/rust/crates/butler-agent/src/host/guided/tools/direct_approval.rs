//! Exact-action approval for direct adapters, including normally exempt writes.
use super::GuidedTools;
use butler_core::json::JsonDocument;
use butler_turn::btcc::{
    AccessDecision, AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityExecutionInput,
    AuthorityOutcomeInput, CapabilityKind, FullOnlyAction, GuidedInvocation, ModelRoundToolCall,
    RequestDecision, ToolExecutionError,
};
use serde_json::{Value, json};

pub(super) fn supports(call: &ModelRoundToolCall) -> bool {
    matches!(
        CapabilityKind::of_call(&call.name, &call.arguments, false),
        CapabilityKind::Exempt(_)
            | CapabilityKind::ButlerOutput
            | CapabilityKind::ProjectRecord
            | CapabilityKind::WorkRecord
            | CapabilityKind::FullOnly(FullOnlyAction::MemoryForget)
    )
}

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    if owner.taint() != butler_turn::btcc::TurnTaint::ConnectorEvent {
        return run(owner, invocation, call, occurrence).await;
    }
    let decision = super::access::for_kind(
        owner,
        CapabilityKind::of_call(&call.name, &call.arguments, false),
    );
    let reference = match decision {
        AccessDecision::Deny(_) => {
            return super::dispatch::encoded(
                &json!({"ok":false,"error":{"code":"access_read_only","message":"This action is not allowed in this access mode."}}),
            );
        }
        AccessDecision::Ask(_) => {
            if owner.unattended() {
                return super::turn_guard::unattended_denial(owner, call).await;
            }
            match gate(owner, call, occurrence).await? {
                Gate::Pending(value) => return super::dispatch::encoded(&value),
                Gate::Allowed(reference) => reference,
            }
        }
        AccessDecision::Allow => None,
    };
    let result = run(owner, invocation, call, occurrence).await;
    if let Some(request_ref) = reference {
        let status = match &result {
            Ok(value) if value.field("ok").ok().flatten() == Some("true") => "applied",
            Ok(_) => "failed",
            Err(_) => "uncertain",
        };
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
    result
}

enum Gate {
    Pending(Value),
    Allowed(Option<String>),
}
async fn gate(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<Gate, ToolExecutionError> {
    let input = Value::Object(call.arguments.clone());
    if super::access::resumes(owner, occurrence) {
        return resume(owner, call, occurrence, &input).await;
    }
    let admitted = super::attention::admit(
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
            target: call.name.clone(),
            normalized_input: input,
            model_ref: owner.binding.model_ref.clone(),
            reasoning_effort: owner.binding.reasoning_effort.clone(),
            category: Some("reviewed_effect".into()),
            public_action_title: Some("authority.taintReason".into()),
            honor_standing_permission: false,
            unattended: owner.unattended(),
        },
    )
    .await
    .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
    Ok(match admitted {
        AuthorityAdmissionResult::Granted => Gate::Allowed(None),
        AuthorityAdmissionResult::Pending { request_ref, .. }
        | AuthorityAdmissionResult::Allowed { request_ref, .. } => Gate::Pending(
            json!({"ok":true,"authority_pending":true,"request_ref":request_ref,"status":"awaiting_allow"}),
        ),
        AuthorityAdmissionResult::Unattended => Gate::Pending(
            super::turn_guard::unattended_feedback(owner, &call.name, &call.name),
        ),
        _ => Gate::Pending(json!({"ok":false,"error":{"code":"authority_request_denied"}})),
    })
}
async fn resume(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
    input: &Value,
) -> Result<Gate, ToolExecutionError> {
    let reference = owner
        .binding
        .authority_request_ref
        .clone()
        .unwrap_or_default();
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
    if stored.decision == RequestDecision::Allowed
        && stored.capability == call.name
        && stored.source_call_id.as_deref() == Some(occurrence)
        && stored.normalized_input == *input
        && stored.normalized_target == call.name
    {
        Ok(Gate::Allowed(Some(reference)))
    } else {
        Ok(Gate::Pending(
            json!({"ok":false,"error":{"code":"authority_request_identity_mismatch"}}),
        ))
    }
}
async fn run(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    if crate::host::GuidedWorkTools::is_work_tool(&call.name) {
        let result = super::dispatch::execute_work(owner, call, occurrence).await?;
        super::dispatch::encoded(&result)
    } else if super::memory_write::supports(&call.name) {
        super::memory_write::execute(owner, invocation, call, occurrence).await
    } else if super::image::supports(&call.name) {
        Box::pin(super::image::execute(owner, invocation, call)).await
    } else if super::profile::supports(&call.name) {
        super::profile::execute(owner, call).await
    } else {
        super::dispatch::domain_tool(owner, &invocation, call, occurrence)
            .await
            .unwrap_or_else(|| {
                super::dispatch::encoded(
                    &json!({"ok":false,"error":{"code":"guided_tool_executor_missing"}}),
                )
            })
    }
}
