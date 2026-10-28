//! Durable ask-first and hand-back waits use the existing #162 continuation lane.
use super::super::GuidedTools;
use butler_turn::btcc::{
    AccessDecision, AccessMode, AuthorityAdmissionInput, AuthorityAdmissionResult,
    AuthorityExecutionInput, CapabilityKind, ModelRoundToolCall, RequestDecision,
    ToolExecutionError, TurnTaint,
};
use serde_json::{Value, json};
pub(super) enum Gate {
    Pending(Value),
    Allowed(Option<String>, Option<String>),
}
pub(super) async fn gate(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
    input: &Value,
    target: &str,
) -> Result<Gate, ToolExecutionError> {
    if owner.schedule_run().is_some() && input["grant"].is_object() {
        super::super::attention::skipped_input(
            owner,
            call,
            input.clone(),
            target,
            "schedule_permission_required",
        )
        .await;
        return Ok(Gate::Pending(
            super::super::turn_guard::unattended_feedback(owner, &call.name, target),
        ));
    }
    if let Some(reference) = resume_reference(owner, occurrence) {
        return resumed_gate(owner, call, occurrence, input, target, reference).await;
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
            action_key: action_key(occurrence, input),
            authority_generation: 1,
            capability: call.name.clone(),
            target: target.into(),
            normalized_input: input.clone(),
            model_ref: owner.binding.model_ref.clone(),
            reasoning_effort: owner.binding.reasoning_effort.clone(),
            category: Some("reviewed_effect".into()),
            public_action_title: Some(if owner.taint() == TurnTaint::ConnectorEvent {
                "authority.taintReason".into()
            } else {
                call.name.clone()
            }),
            honor_standing_permission: owner.taint() != TurnTaint::ConnectorEvent,
            unattended: owner.unattended(),
        },
    )
    .await
    .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
    Ok(match admitted {
        AuthorityAdmissionResult::Granted => Gate::Allowed(None, None),
        AuthorityAdmissionResult::Pending { request_ref, .. }
        | AuthorityAdmissionResult::Allowed { request_ref, .. } => Gate::Pending(
            json!({"ok":true,"authority_pending":true,"request_ref":request_ref,"status":"awaiting_allow"}),
        ),
        // Nobody can answer a payment, sign-in, upload or commit card here.
        AuthorityAdmissionResult::Unattended => Gate::Pending(
            super::super::turn_guard::unattended_feedback(owner, &call.name, target),
        ),
        _ => Gate::Pending(json!({"ok":false,"error":"authority_request_denied"})),
    })
}

/// Resume only the exact action and grant scope the owner approved.
async fn resumed_gate(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
    input: &Value,
    target: &str,
    reference: &str,
) -> Result<Gate, ToolExecutionError> {
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
    Ok(Gate::Allowed(
        Some(reference.to_owned()),
        Some(stored.allow_scope),
    ))
}

/// One durable slot per distinct decision inside a call: a dialog, a site
/// grant, a sign-in fill and a sign-in hand-back never share a request.
fn action_key(occurrence: &str, input: &Value) -> String {
    if let Some(id) = input["dialog"]["id"].as_str() {
        return format!("{occurrence}:dialog:{id}");
    }
    if let Some(grant) = input.get("grant") {
        let site = grant["site"].as_str().unwrap_or("");
        return format!("{occurrence}:grant:{site}");
    }
    if input.get("sign_in").is_some() {
        return format!("{occurrence}:sign_in");
    }
    if input.get("pay").is_some() {
        return format!("{occurrence}:pay");
    }
    if input.get("wait").is_some() {
        return format!("{occurrence}:wait");
    }
    occurrence.into()
}

/// The input of the allowed request this resumed call is bound to, while unconsumed.
pub(super) async fn bound(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<Option<Value>, ToolExecutionError> {
    let Some(reference) = resume_reference(owner, occurrence) else {
        return Ok(None);
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
    Ok((stored.decision == RequestDecision::Allowed
        && stored.capability == call.name
        && stored.source_call_id.as_deref() == Some(occurrence))
    .then_some(stored.normalized_input))
}

pub(super) async fn act_gate(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
    input: &Value,
    target: &str,
) -> Result<Gate, ToolExecutionError> {
    let decision = super::super::access::for_kind(owner, outward_kind(input));
    if owner.taint() == TurnTaint::ConnectorEvent && matches!(decision, AccessDecision::Deny(_)) {
        return Ok(Gate::Pending(
            json!({"status":"not_dispatched","reason":"read_only"}),
        ));
    }
    let tainted_review =
        owner.taint() == TurnTaint::ConnectorEvent && matches!(decision, AccessDecision::Ask(_));
    if tainted_review
        || reviews(&owner.binding.access_mode, input)
        || resume_reference(owner, occurrence).is_some()
    {
        gate(owner, call, occurrence, input, target).await
    } else {
        Ok(Gate::Allowed(None, None))
    }
}

/// Committing sends data; navigating carries data in the destination URL.
fn outward_kind(input: &Value) -> CapabilityKind {
    if input["commit"] == true {
        CapabilityKind::Network
    } else if input["navigation"] == true
        || input["resolved_steps"].as_array().is_some_and(|steps| {
            steps.iter().any(|s| {
                s["hit"]["role"] == "link"
                    || matches!(s["action"].as_str(), Some("back" | "forward" | "reload"))
            })
        })
    {
        CapabilityKind::WebRequest { carries_data: true }
    } else {
        // A page can send through script-backed input without a POST form or
        // a model-declared commit. Unknown browser effects need fresh consent.
        CapabilityKind::OtherEffect
    }
}

/// Which batches a tier asks about: payment and upload steps on every tier,
/// every batch under ask-always, and under ask-first and Auto only a batch
/// that commits something on the user's behalf (the risky browser step).
/// Browsing never asks there.
pub(super) fn reviews(mode: &AccessMode, input: &Value) -> bool {
    input["always_confirm"] == true
        || match mode {
            AccessMode::AskAlways => true,
            AccessMode::AskExceptReads | AccessMode::Auto => input["commit"] == true,
            AccessMode::FullAccess | AccessMode::ReadOnly => false,
        }
}

/// Whether a focus-dependent step may still land on a signed-in commit: only
/// when ask-first or Auto did not review this batch as one.
pub(super) fn commit_cleared(mode: &AccessMode, input: &Value, taint: TurnTaint) -> bool {
    input["commit"] == true
        || taint != TurnTaint::ConnectorEvent
            && !matches!(mode, AccessMode::AskExceptReads | AccessMode::Auto)
}

/// A batch commits when the model declares a step as committing, or when a
/// step posts a form in a signed-in tab, whatever the model declared.
pub(super) fn commits(args: &Value, prepared: &Value) -> bool {
    let declared = args["steps"].as_array().into_iter().flatten();
    let resolved = prepared["steps"].as_array().into_iter().flatten();
    declared.into_iter().any(|step| step["commits"] == true)
        || prepared["profile"] == "signed_in"
            && resolved.into_iter().any(|step| step["form_post"] == true)
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

/// Payment classifiers match the exact targets prepared by the browser host.
pub(super) fn payment_step(step: &Value) -> bool {
    step["payment"] == true && step["submit"] == true
        || step["frame_payment"] == true
        || step["hit"]["frame"]
            .as_str()
            .is_some_and(butler_runtime::browser::payment_host)
}
