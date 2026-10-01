use super::contracts::{
    AuthorityAdmissionResult, AuthorityDecisionResult, AuthorityError, AuthorityRecord,
    AuthorityRequestProjection, AuthorityResult, AuthorityScopeProjection, RequestDecision,
};
use super::{approval, permission};

const COMMAND_DENIAL: &str = "Reviewed command denied. No command was run.";
const EFFECT_DENIAL: &str = "Reviewed operation denied. No change was applied.";

pub(super) fn admission(
    record: &AuthorityRecord,
    collation: &butler_core::locale::LocaleCollation,
) -> AuthorityResult<AuthorityAdmissionResult> {
    match record.decision {
        RequestDecision::Allowed => Ok(AuthorityAdmissionResult::Allowed {
            request_ref: record.request_ref.clone(),
            source_work_id: record.source_work_id.clone(),
            normalized_target: record.normalized_target.clone(),
            normalized_input: serde_json::from_str(&record.normalized_input_json).map_err(
                |source| AuthorityError::policy("authority_request_corrupt").with_source(source),
            )?,
        }),
        RequestDecision::Denied => Ok(AuthorityAdmissionResult::Denied {
            request_ref: record.request_ref.clone(),
            denial_text: if record.category == "reviewed_effect" {
                EFFECT_DENIAL
            } else {
                COMMAND_DENIAL
            },
        }),
        RequestDecision::Modified => Ok(AuthorityAdmissionResult::Modified {
            request_ref: record.request_ref.clone(),
        }),
        RequestDecision::Pending => Ok(AuthorityAdmissionResult::Pending {
            request_ref: record.request_ref.clone(),
            projection: request(record, collation)?,
        }),
    }
}
pub(super) fn request(
    record: &AuthorityRecord,
    collation: &butler_core::locale::LocaleCollation,
) -> AuthorityResult<AuthorityRequestProjection> {
    if record.capability == "ask_user" {
        return Ok(AuthorityRequestProjection {
            request_ref: record.request_ref.clone(),
            category: "ask_user".into(),
            reason: record.reason.clone(),
            executable: record.executable.clone(),
            command_count: 1,
            scope: AuthorityScopeProjection {
                title: String::new(),
                description: String::new(),
            },
            source_turn_id: record.source_turn_id.clone(),
            source_session_id: record.source_session_id.clone(),
            source_call_id: record.source_call_id.clone(),
            approval: None,
            question_state: Some(
                if record.decision == RequestDecision::Pending {
                    "pending"
                } else {
                    "deferred"
                }
                .into(),
            ),
            questions: Some(
                serde_json::from_str(&record.normalized_input_json)
                    .map_err(|_| AuthorityError::policy("authority_request_corrupt"))?,
            ),
        });
    }
    let scope = permission::for_record(record, collation)?;
    let input: serde_json::Value =
        serde_json::from_str(&record.normalized_input_json).map_err(|source| {
            AuthorityError::policy("authority_request_corrupt").with_source(source)
        })?;
    let approval = approval::summarize(approval::ApprovalFacts {
        capability: &record.capability,
        target: &record.normalized_target,
        input: &input,
        workspace: &record.workspace_path,
    });
    Ok(AuthorityRequestProjection {
        request_ref: record.request_ref.clone(),
        category: record.category.clone(),
        reason: record.reason.clone(),
        executable: record.executable.clone(),
        command_count: 1,
        scope: AuthorityScopeProjection {
            title: scope.title,
            description: scope.description,
        },
        source_turn_id: record.source_turn_id.clone(),
        source_session_id: record.source_session_id.clone(),
        source_call_id: record
            .source_call_id
            .clone()
            .filter(|value| !value.is_empty()),
        approval: Some(approval),
        questions: None,
        question_state: None,
    })
}
pub(super) fn decision(record: &AuthorityRecord) -> AuthorityResult<AuthorityDecisionResult> {
    if record.decision == RequestDecision::Pending {
        return Err(AuthorityError::policy("authority_request_not_decided"));
    }
    Ok(AuthorityDecisionResult {
        request_ref: record.request_ref.clone(),
        owner_session_id: record.owner_session_id.clone(),
        source_turn_id: record.source_turn_id.clone(),
        source_work_id: record.source_work_id.clone(),
        schedule_client_message_id: record.schedule_client_message_id.clone(),
        schedule_input_text: record.schedule_input_text.clone(),
        model_ref: record.model_ref.clone(),
        reasoning_effort: record.reasoning_effort.clone(),
        decision: record.decision,
        question_followup: (record.capability == "ask_user")
            .then(|| {
                record
                    .outcome_receipt_json
                    .as_ref()
                    .map(|response| format!("{}\n{response}", record.normalized_input_json))
            })
            .flatten(),
    })
}
