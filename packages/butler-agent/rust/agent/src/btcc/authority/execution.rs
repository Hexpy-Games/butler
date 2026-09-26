use serde_json::Value;

use super::contracts::{
    AuthorityError, AuthorityExecutionInput, AuthorityOutcomeInput, AuthorityRepository,
    AuthorityResult, AuthorityStoredExecution, OutcomeWrite,
};
use super::{identity, receipt};

pub(super) fn execution(
    repository: &mut dyn AuthorityRepository,
    input: AuthorityExecutionInput,
) -> AuthorityResult<AuthorityStoredExecution> {
    let record = repository
        .find_ref(&input.request_ref)?
        .filter(|record| record.owner_session_id == input.owner_session_id)
        .filter(|record| {
            input
                .source_session_id
                .as_ref()
                .is_none_or(|session| &record.source_session_id == session)
        })
        .filter(|record| {
            input
                .client_message_id
                .as_ref()
                .is_none_or(|id| &record.schedule_client_message_id == id)
        })
        .ok_or_else(|| AuthorityError::policy("authority_request_not_found"))?;
    if !matches!(record.decision.as_str(), "allowed" | "denied" | "modified") {
        return Err(AuthorityError::policy("authority_request_not_allowed"));
    }
    if record.source_turn_id != input.turn_id {
        return Err(AuthorityError::policy("authority_schedule_turn_mismatch"));
    }
    if record.decision == "modified"
        && record
            .private_alternative_input
            .as_deref()
            .is_none_or(|value| crate::public_text::trim_js_whitespace(value).is_empty())
    {
        return Err(AuthorityError::policy("authority_request_corrupt"));
    }
    let normalized_input: Value = serde_json::from_str(&record.normalized_input_json)
        .map_err(|_| AuthorityError::policy("authority_request_corrupt"))?;
    let outcome_receipt = record
        .outcome_receipt_json
        .as_deref()
        .map(|json| {
            receipt::parse(json).ok_or_else(|| AuthorityError::policy("authority_request_corrupt"))
        })
        .transpose()?;
    Ok(AuthorityStoredExecution {
        request_ref: record.request_ref,
        source_session_id: record.source_session_id,
        source_turn_id: record.source_turn_id,
        source_call_id: record.source_call_id.filter(|value| !value.is_empty()),
        source_work_id: record.source_work_id,
        workspace_path: record.workspace_path,
        plan_revision_id: record.plan_revision_id,
        action_key: record.action_key,
        authority_generation: record.authority_generation,
        capability: record.capability,
        normalized_target: record.normalized_target,
        category: record.category,
        normalized_input,
        decision: record.decision,
        alternative_input: record
            .private_alternative_input
            .filter(|value| !value.is_empty()),
        outcome: record.outcome,
        outcome_receipt,
    })
}
pub(super) fn record_outcome(
    repository: &mut dyn AuthorityRepository,
    input: AuthorityOutcomeInput,
    collation: &crate::locale::LocaleCollation,
    clock: &dyn Fn() -> String,
) -> AuthorityResult<()> {
    let record = repository
        .find_ref(&input.request_ref)?
        .filter(|record| {
            record.owner_session_id == input.owner_session_id
                && record.source_work_id == input.source_work_id
        })
        .ok_or_else(|| AuthorityError::policy("authority_outcome_identity_mismatch"))?;
    let _ = record;
    let receipt_json = input
        .receipt
        .as_ref()
        .map(|value| identity::canonical(value, collation))
        .transpose()?;
    repository.record_outcome(OutcomeWrite {
        request_ref: input.request_ref,
        source_work_id: input.source_work_id,
        status: input.status,
        receipt_json,
        now: clock(),
    })
}
