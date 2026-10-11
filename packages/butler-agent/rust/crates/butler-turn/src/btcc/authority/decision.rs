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
    let action = if input.action == "answer" {
        AuthorityAction::Modify
    } else {
        AuthorityAction::parse(&input.action)
    };
    let alternative = alternative_input(input, action)?;
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
    if let Some(decision) = question_decision(
        repository,
        &current,
        input,
        alternative.as_deref(),
        collation,
        clock,
    )? {
        return Ok(decision);
    }
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
    check_allow_scope(&current, input)?;
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
    let action = if input.action == "answer" {
        AuthorityAction::Modify
    } else {
        AuthorityAction::parse(&input.action)
    };
    record.decision == action.decision()
        && (action != AuthorityAction::Allow
            || record.allow_scope == input.allow_scope.as_deref().unwrap_or("once"))
        && (action != AuthorityAction::Modify
            || record.private_alternative_input.as_deref() == alternative)
}

fn question_decision(
    repository: &mut dyn AuthorityRepository,
    current: &AuthorityRecord,
    input: &AuthorityDecisionInput,
    alternative: Option<&str>,
    collation: &butler_core::locale::LocaleCollation,
    clock: &dyn Fn() -> String,
) -> AuthorityResult<Option<AuthorityDecisionResult>> {
    if current.capability == "ask_user" {
        if input.action != "answer" {
            return Err(AuthorityError::policy("question_answer_invalid"));
        }
        let questions: super::questions::UserQuestions =
            serde_json::from_str(&current.normalized_input_json)
                .map_err(|_| AuthorityError::policy("authority_request_corrupt"))?;
        let response: super::questions::UserQuestionResponse =
            serde_json::from_str(alternative.unwrap_or(""))
                .map_err(|_| AuthorityError::policy("question_answer_invalid"))?;
        questions.validate_answer(&response)?;
        if current.decision == RequestDecision::Modified
            && current
                .private_alternative_input
                .as_deref()
                .is_some_and(|s| {
                    serde_json::from_str::<super::questions::UserQuestionResponse>(s).ok()
                        == Some(super::questions::UserQuestionResponse::Deferred)
                })
        {
            return super::questions::answer_deferred(
                repository, current, &response, collation, clock,
            )
            .map(Some);
        }
    } else if input.action == "answer" {
        return Err(AuthorityError::policy("question_answer_invalid"));
    }
    Ok(None)
}

fn alternative_input(
    input: &AuthorityDecisionInput,
    action: AuthorityAction,
) -> AuthorityResult<Option<String>> {
    if action == AuthorityAction::Modify {
        let value = input.alternative_input.as_deref().unwrap_or("");
        if butler_core::public_text::trim_js_whitespace(value).is_empty() {
            return Err(AuthorityError::policy("authority_modify_input_missing"));
        }
        if input.action != "answer" && value.len() > 16 * 1024 {
            return Err(AuthorityError::policy("authority_modify_input_too_large"));
        }
        Ok(Some(value.to_owned()))
    } else {
        Ok(None)
    }
}

fn check_allow_scope(
    current: &AuthorityRecord,
    input: &AuthorityDecisionInput,
) -> AuthorityResult<()> {
    let normalized: serde_json::Value = serde_json::from_str(&current.normalized_input_json)
        .map_err(|_| AuthorityError::policy("authority_request_corrupt"))?;
    if input.allow_scope.as_deref() == Some("conversation")
        && (normalized.get("always_confirm") == Some(&serde_json::Value::Bool(true))
            || current.capability == "browser_wait_for_user")
    {
        return Err(AuthorityError::policy("browser_confirm_once_required"));
    }
    Ok(())
}
