//! One admitted, durable authority occurrence gates persistent Effects.

use serde_json::{Value, json};

use crate::btcc::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityExecutionInput,
    AuthorityOutcomeInput, EffectAdapter, EffectOutcome, ModelRoundToolCall, WorkView,
    effect_input_sha256, reviewed_effect_action_key,
};
use crate::json::JsonDocument;

use super::{NativeGuidedTools, ToolExecutionError, ordinary, wire_error};

pub(super) enum Gate {
    Return(JsonDocument),
    Execute(Option<Approved>),
}

pub(super) struct Approved {
    request_ref: String,
    source_work_id: String,
}

fn error(code: &str, message: &str) -> Result<Gate, ToolExecutionError> {
    ordinary(code, message, None).map(Gate::Return)
}

fn public_action_title(call: &ModelRoundToolCall) -> Option<String> {
    if call.name != "run_command" {
        return None;
    }
    let raw = call.arguments.get("summary")?.as_str()?;
    let raw = crate::public_text::trim_js_whitespace(raw);
    if raw.is_empty() || raw.contains(['\n', '\r']) || raw.chars().count() > 32 {
        return None;
    }
    let title = crate::public_text::sanitize_public_text(raw, "");
    let title = crate::public_text::trim_js_whitespace(&title);
    (!title.is_empty() && title.chars().count() <= 32).then(|| title.to_owned())
}

pub(super) async fn gate(
    owner: &NativeGuidedTools,
    call: &ModelRoundToolCall,
    occurrence: &str,
    work: &WorkView,
    target: &str,
    input: &Value,
    adapter: &dyn EffectAdapter,
) -> Result<Gate, ToolExecutionError> {
    let normalized_target = match adapter.normalize_target(target) {
        Ok(value) => value,
        Err(failure) => return error(&failure.code, &failure.message),
    };
    let normalized_input = match adapter.normalize_input(input) {
        Ok(value) => value,
        Err(failure) => return error(&failure.code, &failure.message),
    };
    let action_key = match reviewed_effect_action_key(work, adapter, &normalized_target) {
        Ok(value) => value,
        Err(failure) => return error(&failure.code, &failure.message),
    };
    let plan = match &work.current_plan {
        Some(plan) => plan,
        None => {
            return error(
                "effect_plan_review_required",
                "The current Plan revision is required before requesting Allow.",
            );
        }
    };
    let resume_ref = owner.binding.authority_request_ref.as_deref().filter(|_| {
        owner.binding.authority_source_call_id.as_deref() == Some(occurrence)
            && !*owner
                .authority_consumed
                .lock()
                .expect("authority state poisoned")
    });
    if let Some(request_ref) = resume_ref {
        let execution = match owner
            .authority
            .execution(AuthorityExecutionInput {
                owner_session_id: owner.binding.owner_session_id.clone(),
                request_ref: request_ref.to_owned(),
                source_session_id: Some(owner.binding.source_session_id.clone()),
                client_message_id: None,
                turn_id: owner.binding.turn_id.clone(),
            })
            .await
        {
            Ok(value) => value,
            Err(failure) => {
                return error(
                    &failure.code,
                    "The permission does not belong to this operation.",
                );
            }
        };
        if execution.source_work_id != work.work_id
            || execution.workspace_path != owner.binding.workspace_path.to_string_lossy()
            || execution.source_call_id.as_deref() != Some(occurrence)
            || execution.decision != "allowed"
            || execution.capability != adapter.capability()
            || execution.normalized_target != normalized_target
            || effect_input_sha256(&execution.normalized_input)
                .ok()
                .zip(effect_input_sha256(&normalized_input).ok())
                .is_none_or(|(stored, current)| stored != current)
            || execution.plan_revision_id != plan.plan_revision_id
            || execution.action_key != action_key
        {
            return error(
                "authority_request_identity_mismatch",
                "The stored command identity changed before execution.",
            );
        }
        return Ok(Gate::Execute(Some(Approved {
            request_ref: request_ref.to_owned(),
            source_work_id: work.work_id.clone(),
        })));
    }
    let input = AuthorityAdmissionInput {
        public_action_title: public_action_title(call),
        owner_session_id: owner.binding.owner_session_id.clone(),
        source_session_id: owner.binding.source_session_id.clone(),
        source_turn_id: owner.binding.turn_id.clone(),
        operation_occurrence_id: Some(occurrence.to_owned()),
        source_work_id: work.work_id.clone(),
        workspace_path: owner.binding.workspace_path.to_string_lossy().into_owned(),
        plan_revision_id: plan.plan_revision_id.clone(),
        action_key,
        authority_generation: 1,
        capability: adapter.capability().to_owned(),
        target: normalized_target,
        model_ref: owner.binding.model_ref.clone(),
        reasoning_effort: owner.binding.reasoning_effort.clone(),
        category: (call.name != "run_command").then(|| "reviewed_effect".to_owned()),
        normalized_input,
    };
    let admitted = match owner.authority.admit(input).await {
        Ok(value) => value,
        Err(failure) => {
            return error(
                &failure.code,
                "The command authority identity could not be admitted.",
            );
        }
    };
    match admitted {
        AuthorityAdmissionResult::Granted => Ok(Gate::Execute(None)),
        AuthorityAdmissionResult::Pending { request_ref, .. }
        | AuthorityAdmissionResult::Allowed { request_ref, .. } => {
            let body = json!({"ok":true,"authority_pending":true,"request_ref":request_ref,
                "status":"awaiting_allow","message":"This reviewed operation is waiting for Allow before dispatch."});
            JsonDocument::from_value(&body)
                .map(Gate::Return)
                .map_err(wire_error)
        }
        AuthorityAdmissionResult::Denied { denial_text, .. } => {
            let body = json!({"ok":false,"error":{"code":"authority_request_denied",
                "message":denial_text,"next_action":"Report the denial or choose a non-effectful alternative."}});
            JsonDocument::from_value(&body)
                .map(Gate::Return)
                .map_err(wire_error)
        }
        AuthorityAdmissionResult::Modified { .. } => error(
            "authority_request_modified",
            "The reviewed command was replaced before it could run.",
        ),
    }
}

pub(super) async fn settle(
    owner: &NativeGuidedTools,
    approved: Approved,
    outcome: &EffectOutcome,
) -> Result<Option<JsonDocument>, ToolExecutionError> {
    let (status, receipt) = match outcome {
        EffectOutcome::Applied { receipt, .. } => {
            let Some(attempt) = receipt
                .dispatch_attempt
                .as_ref()
                .and_then(Value::as_i64)
                .filter(|n| *n > 0)
            else {
                return invalid();
            };
            if !valid_effect(&receipt.effect_id, &receipt.identity_sha256)
                || receipt.receipt_id
                    != format!("guided-effect-receipt-{}", receipt.identity_sha256)
            {
                return invalid();
            }
            (
                "applied",
                Some(json!({"schema":"butler.authority-outcome-receipt.v1",
                "outcome":"applied","evidenceRef":format!("authority-evidence-{}",receipt.identity_sha256),
                "journalEffectId":receipt.effect_id,"dispatchAttempt":attempt})),
            )
        }
        EffectOutcome::Rejected(_) | EffectOutcome::Failed(_) => ("failed", None),
        EffectOutcome::Uncertain {
            evidence: Some(evidence),
            ..
        } => {
            if !valid_effect(&evidence.effect_id, &evidence.identity_sha256)
                || evidence.dispatch_attempt <= 0
                || !matches!(
                    evidence.error_code.as_str(),
                    "effect_work_plan_missing"
                        | "effect_plan_review_required"
                        | "effect_action_not_found"
                        | "effect_action_ambiguous"
                        | "effect_request_invalid"
                        | "effect_identity_conflict"
                        | "effect_access_denied"
                        | "effect_cancelled"
                        | "effect_dispatch_failed"
                        | "effect_reconciliation_required"
                        | "effect_journal_conflict"
                )
            {
                return invalid();
            }
            (
                "uncertain",
                Some(json!({"schema":"butler.authority-outcome-receipt.v1",
                "outcome":"uncertain","evidenceRef":format!("authority-evidence-{}",evidence.identity_sha256),
                "journalEffectId":evidence.effect_id,"dispatchAttempt":evidence.dispatch_attempt,
                "errorCode":evidence.error_code})),
            )
        }
        EffectOutcome::Uncertain { evidence: None, .. } => return invalid(),
    };
    owner
        .authority
        .record_outcome(AuthorityOutcomeInput {
            request_ref: approved.request_ref,
            owner_session_id: owner.binding.owner_session_id.clone(),
            source_work_id: approved.source_work_id,
            status: status.to_owned(),
            receipt,
        })
        .await
        .map_err(|failure| {
            ToolExecutionError::Integrity(crate::btcc::BtccError::new(
                failure.code,
                failure.message,
            ))
        })?;
    *owner
        .authority_consumed
        .lock()
        .expect("authority state poisoned") = true;
    Ok(None)
}

fn invalid() -> Result<Option<JsonDocument>, ToolExecutionError> {
    ordinary(
        "authority_outcome_receipt_invalid",
        "The command outcome could not be recorded.",
        None,
    )
    .map(Some)
}

fn valid_effect(effect_id: &str, identity: &str) -> bool {
    fn sha(value: &str) -> bool {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }
    sha(identity) && effect_id.strip_prefix("guided-effect-").is_some_and(sha)
}
