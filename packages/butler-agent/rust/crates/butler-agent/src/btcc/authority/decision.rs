use super::contracts::{
    AuthorityDecisionInput, AuthorityDecisionResult, AuthorityError, AuthorityRecord,
    AuthorityRepository, AuthorityResult, DecisionWrite,
};
use super::{permission, projection};

pub(super) fn decide(
    repository: &mut dyn AuthorityRepository,
    input: &AuthorityDecisionInput,
    collation: &crate::locale::LocaleCollation,
    clock: &dyn Fn() -> String,
) -> AuthorityResult<AuthorityDecisionResult> {
    let alternative = if input.action == "modify" {
        let value = input.alternative_input.as_deref().unwrap_or("");
        if crate::public_text::trim_js_whitespace(value).is_empty() {
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
    if current.decision != "pending" {
        if same(&current, input, alternative.as_deref()) {
            return projection::decision(&current);
        }
        return Err(AuthorityError::policy(
            if input.action == "modify" && current.decision == "modified" {
                "authority_modify_identity_mismatch"
            } else {
                "authority_decision_conflict"
            },
        ));
    }
    if !repository.source_work_eligible(&current.source_session_id, &current.source_work_id)? {
        return Err(AuthorityError::policy("authority_request_not_found"));
    }
    let permission =
        if input.action == "allow" && input.allow_scope.as_deref() == Some("conversation") {
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
        action: input.action.clone(),
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
    let expected = match input.action.as_str() {
        "allow" => "allowed",
        "deny" => "denied",
        _ => "modified",
    };
    record.decision == expected
        && (input.action != "allow"
            || record.allow_scope == input.allow_scope.as_deref().unwrap_or("once"))
        && (input.action != "modify" || record.private_alternative_input.as_deref() == alternative)
}
