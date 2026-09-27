use super::contracts::{
    AuthorityAction, AuthorityDecisionInput, AuthorityDecisionResult, AuthorityError,
    AuthorityRecord, AuthorityRepository, AuthorityResult, DecisionWrite, RequestDecision,
};
use super::{permission, projection};

pub(super) fn decide(
    repository: &mut dyn AuthorityRepository,
    input: &AuthorityDecisionInput,
    collation: &butler_core::locale::LocaleCollation,
    clock: &dyn Fn() -> String,
) -> AuthorityResult<AuthorityDecisionResult> {
    let action = AuthorityAction::parse(&input.action);
    let alternative = if action == AuthorityAction::Modify {
        let value = input.alternative_input.as_deref().unwrap_or("");
        if butler_core::public_text::trim_js_whitespace(value).is_empty() {
            return Err(AuthorityError::policy("authority_modify_input_missing"));
        }
        if value.len() > 16 * 1024 {
            return Err(AuthorityError::policy("authority_modify_input_too_large"));
        }
        Some(value.to_owned())
    } else {
        None
    };
    let current = repository
        .find_ref(&input.request_ref)?
        .filter(|record| record.owner_session_id == input.owner_session_id)
        .filter(|record| {
            input
                .source_session_id
                .as_ref()
                .is_none_or(|session| &record.source_session_id == session)
        })
        .ok_or_else(|| AuthorityError::policy("authority_request_not_found"))?;
    if current.decision != RequestDecision::Pending {
        if same(&current, input, alternative.as_deref()) {
            return projection::decision(&current);
        }
        return Err(AuthorityError::policy(
            if action == AuthorityAction::Modify && current.decision == RequestDecision::Modified {
                "authority_modify_identity_mismatch"
            } else {
                "authority_decision_conflict"
            },
        ));
    }
    if !repository.source_work_eligible(&current.source_session_id, &current.source_work_id)? {
        return Err(AuthorityError::policy("authority_request_not_found"));
    }
    let permission = if action == AuthorityAction::Allow
        && input.allow_scope.as_deref() == Some("conversation")
    {
        let mut grant = permission::for_record(&current, collation)?;
        grant.created_at = clock();
        Some(grant)
    } else {
        None
    };
    let write = DecisionWrite {
        request_ref: input.request_ref.clone(),
        owner_session_id: input.owner_session_id.clone(),
        source_session_id: current.source_session_id,
        action,
        permission,
        alternative_input: alternative.clone(),
        now: clock(),
    };
    let decided = repository.decide(write)?;
    if let Some(record) = decided {
        return projection::decision(&record);
    }
    if let Some(raced) = repository.find_ref(&input.request_ref)?
        && same(&raced, input, alternative.as_deref())
    {
        return projection::decision(&raced);
    }
    Err(AuthorityError::policy("authority_decision_conflict"))
}
fn same(
    record: &AuthorityRecord,
    input: &AuthorityDecisionInput,
    alternative: Option<&str>,
) -> bool {
    let action = AuthorityAction::parse(&input.action);
    record.decision == action.decision()
        && (action != AuthorityAction::Allow
            || record.allow_scope == input.allow_scope.as_deref().unwrap_or("once"))
        && (action != AuthorityAction::Modify
            || record.private_alternative_input.as_deref() == alternative)
}
