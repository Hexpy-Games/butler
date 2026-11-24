use super::{GuidedTools, dispatch::encoded};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityExecutionInput,
    AuthorityOutcomeInput, ModelRoundToolCall, RequestDecision, ToolExecutionError, TurnTaint,
    proposal_shape,
};
use serde_json::{Value, json};

pub(super) async fn execute(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    if owner.unattended() {
        return encoded(&json!({"ok":false,"error":{"code":"unavailable_unattended"}}));
    }
    if super::access::resumes(owner, occurrence) {
        return resume(owner, call, occurrence).await;
    }
    let args = &call.arguments;
    let text = |key| args.get(key).and_then(Value::as_str).unwrap_or_default();
    let (effect, kind, pattern, scope, reason) = (
        text("effect"),
        text("kind"),
        text("pattern"),
        text("scope"),
        text("reason"),
    );
    let invalid =
        |code| encoded(&json!({"ok":false,"error":{"code":"invalid_arguments","message":code}}));
    if !matches!(effect, "allow" | "deny")
        || !matches!(scope, "conversation" | "always")
        || pattern.is_empty()
        || pattern.chars().count() > 300
        || reason.chars().count() > 200
        || !args.get("reason").is_some_and(Value::is_string)
    {
        return invalid("rule_shape_invalid");
    }
    let pattern = match proposal_shape(effect, kind, pattern, scope) {
        Ok(Some(prefix)) => prefix,
        Ok(None) => match owner
            .allowed_folder(pattern.to_owned())
            .await
            .map_err(ToolExecutionError::Integrity)?
        {
            Ok(path) => path.to_string_lossy().into_owned(),
            Err(refusal) => return invalid(refusal.code()),
        },
        Err(code) => return invalid(code),
    };
    let input =
        json!({"effect":effect,"kind":kind,"pattern":pattern,"scope":scope,"reason":reason});
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
            target: pattern,
            normalized_input: input,
            model_ref: owner.binding.model_ref.clone(),
            reasoning_effort: owner.binding.reasoning_effort.clone(),
            category: Some("reviewed_effect".into()),
            public_action_title: (owner.taint() != TurnTaint::Clean)
                .then(|| "authority.taintReason".into()),
            honor_standing_permission: false,
            unattended: false,
        },
    )
    .await
    .map_err(|error| ToolExecutionError::Integrity(error.into()))?;
    encoded(&match admitted {
        AuthorityAdmissionResult::Pending { request_ref, .. }
        | AuthorityAdmissionResult::Allowed { request_ref, .. } => {
            json!({"ok":true,"authority_pending":true,"request_ref":request_ref,"status":"awaiting_allow"})
        }
        _ => json!({"ok":false,"error":{"code":"authority_request_denied"}}),
    })
}

async fn resume(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let request_ref = owner
        .binding
        .authority_request_ref
        .clone()
        .unwrap_or_default();
    let stored = owner
        .authority
        .execution(AuthorityExecutionInput {
            owner_session_id: owner.binding.owner_session_id.clone(),
            request_ref: request_ref.clone(),
            source_session_id: Some(owner.binding.source_session_id.clone()),
            client_message_id: None,
            turn_id: owner.binding.turn_id.clone(),
        })
        .await
        .map_err(|error| ToolExecutionError::Integrity(error.into()))?;
    if stored.decision != RequestDecision::Allowed
        || stored.capability != call.name
        || stored.source_call_id.as_deref() != Some(occurrence)
    {
        return encoded(&json!({"ok":false,"error":{"code":"authority_request_denied"}}));
    }
    owner
        .authority
        .record_outcome(AuthorityOutcomeInput {
            request_ref,
            owner_session_id: owner.binding.owner_session_id.clone(),
            source_work_id: String::new(),
            status: "applied".into(),
            receipt: None,
        })
        .await
        .map_err(|error| ToolExecutionError::Integrity(error.into()))?;
    *owner.authority_consumed.lock() = true;
    encoded(&json!({"ok":true,"status":"added"}))
}
