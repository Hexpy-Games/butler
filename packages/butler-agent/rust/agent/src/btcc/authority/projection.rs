use serde_json::{Value, json};

use super::contracts::{
    AuthorityAdmissionResult, AuthorityDecisionResult, AuthorityError, AuthorityRecord,
    AuthorityResult,
};
use super::permission;

const COMMAND_DENIAL: &str = "Reviewed command denied. No command was run.";
const EFFECT_DENIAL: &str = "Reviewed operation denied. No change was applied.";

pub(super) fn admission(
    record: &AuthorityRecord,
    collation: &crate::locale::LocaleCollation,
) -> AuthorityResult<AuthorityAdmissionResult> {
    match record.decision.as_str() {
        "allowed" => Ok(AuthorityAdmissionResult::Allowed {
            request_ref: record.request_ref.clone(),
            source_work_id: record.source_work_id.clone(),
            normalized_target: record.normalized_target.clone(),
            normalized_input: serde_json::from_str(&record.normalized_input_json)
                .map_err(|_| AuthorityError::policy("authority_request_corrupt"))?,
        }),
        "denied" => Ok(AuthorityAdmissionResult::Denied {
            request_ref: record.request_ref.clone(),
            denial_text: if record.category == "reviewed_effect" {
                EFFECT_DENIAL
            } else {
                COMMAND_DENIAL
            },
        }),
        "modified" => Ok(AuthorityAdmissionResult::Modified {
            request_ref: record.request_ref.clone(),
        }),
        _ => Ok(AuthorityAdmissionResult::Pending {
            request_ref: record.request_ref.clone(),
            projection: request(record, collation)?,
        }),
    }
}
pub(super) fn request(
    record: &AuthorityRecord,
    collation: &crate::locale::LocaleCollation,
) -> AuthorityResult<Value> {
    let scope = permission::for_record(record, collation)?;
    let mut output = json!({
        "request_ref": record.request_ref,
        "category": record.category,
        "reason": record.reason,
        "executable": record.executable,
        "command_count": 1,
        "scope": {"title": scope.title, "description": scope.description},
        "source_turn_id": record.source_turn_id,
        "source_session_id": record.source_session_id,
    });
    if let Some(call) = record
        .source_call_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        output["source_call_id"] = json!(call);
    }
    Ok(output)
}
pub(super) fn decision(record: &AuthorityRecord) -> AuthorityResult<AuthorityDecisionResult> {
    if record.decision == "pending" {
        return Err(AuthorityError::policy("authority_request_not_decided"));
    }
    Ok(AuthorityDecisionResult {
        request_ref: record.request_ref.clone(),
        source_session_id: record.source_session_id.clone(),
        source_turn_id: record.source_turn_id.clone(),
        source_work_id: record.source_work_id.clone(),
        schedule_client_message_id: record.schedule_client_message_id.clone(),
        schedule_input_text: record.schedule_input_text.clone(),
        model_ref: record.model_ref.clone(),
        reasoning_effort: record.reasoning_effort.clone(),
        decision: record.decision.clone(),
    })
}
