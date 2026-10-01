//! Structured questions share the durable decision lane and turn continuation.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use super::contracts::*;
use super::{identity, projection};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserQuestions {
    pub questions: Vec<UserQuestion>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserQuestion {
    pub id: String,
    pub eyebrow: String,
    pub title: String,
    pub kind: QuestionKind,
    pub options: Vec<QuestionOption>,
    pub allow_custom: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionKind {
    Single,
    Multi,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub recommended: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserQuestionAnswer {
    pub id: String,
    pub selected: Vec<String>,
    pub custom: Option<String>,
    #[serde(default)]
    pub skipped: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum UserQuestionResponse {
    Answered { answers: Vec<UserQuestionAnswer> },
    Deferred,
}

impl UserQuestions {
    /// Strict tool validation; callers return this error to the model for retry.
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(1..=4).contains(&self.questions.len()) {
            return Err("Provide 1–4 questions.");
        }
        let mut ids = HashSet::new();
        for q in &self.questions {
            if !text(&q.id, 64)
                || !ids.insert(&q.id)
                || !text(&q.eyebrow, 64)
                || !text(&q.title, 2048)
            {
                return Err("Questions need unique ids, a short eyebrow and a nonempty title.");
            }
            if !(2..=6).contains(&q.options.len()) {
                return Err("Each question needs 2–6 options.");
            }
            let mut options = HashSet::new();
            for option in &q.options {
                if !text(&option.id, 64)
                    || !options.insert(&option.id)
                    || !text(&option.label, 512)
                    || option.description.as_ref().is_some_and(|s| !text(s, 2048))
                {
                    return Err("Options need unique ids and nonempty labels and descriptions.");
                }
            }
        }
        Ok(())
    }
    pub(super) fn validate_answer(&self, response: &UserQuestionResponse) -> AuthorityResult<()> {
        let UserQuestionResponse::Answered { answers } = response else {
            return Ok(());
        };
        let invalid = || AuthorityError::policy("question_answer_invalid");
        if answers.len() != self.questions.len() {
            return Err(invalid());
        }
        let mut ids = HashSet::new();
        for answer in answers {
            let q = self
                .questions
                .iter()
                .find(|q| q.id == answer.id)
                .ok_or_else(invalid)?;
            let mut selected = HashSet::new();
            if !ids.insert(&answer.id)
                || answer
                    .selected
                    .iter()
                    .any(|id| !selected.insert(id) || !q.options.iter().any(|o| &o.id == id))
                || (q.kind == QuestionKind::Single && answer.selected.len() > 1)
                || answer
                    .custom
                    .as_ref()
                    .is_some_and(|s| !q.allow_custom || !text(s, 4096))
                || (answer.skipped && (!answer.selected.is_empty() || answer.custom.is_some()))
                || (!answer.skipped && answer.selected.is_empty() && answer.custom.is_none())
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
fn text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.chars().count() <= max
}

/// The exact tool occurrence asking the owner, independent of Work/Plan permissions.
pub struct QuestionBinding {
    pub owner_session_id: String,
    pub source_session_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub model_ref: String,
    pub reasoning_effort: String,
}
impl PrincipalAuthority {
    pub async fn ask_user(
        &self,
        binding: QuestionBinding,
        questions: UserQuestions,
    ) -> AuthorityResult<AuthorityAdmissionResult> {
        questions
            .validate()
            .map_err(|_| AuthorityError::policy("question_input_invalid"))?;
        let collation = self.collation.clone();
        let now = (self.clock)();
        self.in_lane(move |repo| {
            let sha = identity::digest(&format!(
                "ask_user\0{}\0{}",
                binding.turn_id, binding.call_id
            ));
            if let Some(record) = repo.find_identity(&sha)? {
                if record.owner_session_id != binding.owner_session_id
                    || record.source_session_id != binding.source_session_id
                    || record.close_reason.is_some()
                {
                    return Err(AuthorityError::policy("authority_request_not_found"));
                }
                if record.normalized_input_json
                    != identity::canonical(
                        &serde_json::to_value(&questions)
                            .map_err(|_| AuthorityError::policy("question_input_invalid"))?,
                        &collation,
                    )?
                {
                    return Err(AuthorityError::policy("authority_slot_identity_mismatch"));
                }
                return projection::admission(&record, &collation);
            }
            let record = question_record(binding, questions, sha, now, &collation)?;
            repo.insert(&record)?;
            projection::admission(&record, &collation)
        })
        .await
    }
}
fn question_record(
    b: QuestionBinding,
    questions: UserQuestions,
    sha: String,
    now: String,
    collation: &butler_core::locale::LocaleCollation,
) -> AuthorityResult<AuthorityRecord> {
    let input = serde_json::to_value(questions)
        .map_err(|_| AuthorityError::policy("question_input_invalid"))?;
    let schedule_client_message_id = format!("question-answer-{sha}");
    Ok(AuthorityRecord {
        request_id: format!("question-{sha}"),
        request_ref: format!("question-ref-{sha}"),
        identity_sha256: sha,
        owner_session_id: b.owner_session_id,
        source_session_id: b.source_session_id,
        source_turn_id: b.turn_id,
        source_call_id: Some(b.call_id.clone()),
        // Questions have no reviewed operation or permission scope. The occurrence is the slot.
        source_work_id: String::new(),
        workspace_path: String::new(),
        plan_revision_id: String::new(),
        action_key: b.call_id.clone(),
        authority_generation: 1,
        capability: "ask_user".into(),
        normalized_target: "user".into(),
        normalized_input_json: identity::canonical(&input, collation)?,
        model_ref: b.model_ref,
        reasoning_effort: b.reasoning_effort,
        // Preserve the deployed table CHECK; the capability identifies the question subtype.
        category: "reviewed_effect".into(),
        reason: "Answer questions".into(),
        executable: "ask_user".into(),
        command_count: 1,
        decision: RequestDecision::Pending,
        allow_scope: "once".into(),
        schedule_client_message_id,
        schedule_input_text: String::new(),
        private_alternative_input: None,
        outcome: RequestOutcome::Pending,
        outcome_receipt_json: None,
        close_reason: None,
        close_scope: None,
        closed_at: None,
        created_at: now.clone(),
        updated_at: now,
    })
}

impl AuthorityStoredExecution {
    pub fn question_response(&self) -> AuthorityResult<UserQuestionResponse> {
        if self.capability != "ask_user" {
            return Err(AuthorityError::policy("question_answer_invalid"));
        }
        serde_json::from_str(self.alternative_input.as_deref().unwrap_or(""))
            .map_err(|_| AuthorityError::policy("authority_request_corrupt"))
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct AnsweredQuestion {
    pub request_ref: String,
    pub source_turn_id: String,
    pub updated_at: String,
    pub questions: UserQuestions,
    pub response: UserQuestionResponse,
}
impl PrincipalAuthority {
    /// A fresh session projection, read in one SQLite lane operation. Only pending
    /// requests and answers belonging to visible turns are hydrated and decoded.
    pub async fn session_requests(
        &self,
        owner: String,
        turns: Vec<String>,
    ) -> AuthorityResult<(Vec<AuthorityRequestProjection>, Vec<AnsweredQuestion>)> {
        let collation = self.collation.clone();
        self.in_lane(move |repo| {
            let pending = repo
                .list_pending(&owner)?
                .iter()
                .map(|record| projection::request(record, &collation))
                .collect::<AuthorityResult<Vec<_>>>()?;
            let answers = repo
                .question_history(&owner, &turns)?
                .into_iter()
                .map(answered_question)
                .collect::<AuthorityResult<Vec<_>>>()?;
            Ok((pending, answers))
        })
        .await
    }
}

fn answered_question(r: AuthorityRecord) -> AuthorityResult<AnsweredQuestion> {
    let corrupt = || AuthorityError::policy("authority_request_corrupt");
    Ok(AnsweredQuestion {
        request_ref: r.request_ref,
        source_turn_id: r.source_turn_id,
        updated_at: r.updated_at,
        questions: serde_json::from_str(&r.normalized_input_json).map_err(|_| corrupt())?,
        response: serde_json::from_str(
            r.outcome_receipt_json
                .as_deref()
                .or(r.private_alternative_input.as_deref())
                .unwrap_or(""),
        )
        .map_err(|_| corrupt())?,
    })
}

pub(super) fn answer_deferred(
    repo: &mut dyn AuthorityRepository,
    record: &AuthorityRecord,
    response: &UserQuestionResponse,
    collation: &butler_core::locale::LocaleCollation,
    clock: &dyn Fn() -> String,
) -> AuthorityResult<AuthorityDecisionResult> {
    if *response == UserQuestionResponse::Deferred {
        return projection::decision(record);
    }
    let raw = identity::canonical(
        &serde_json::to_value(response)
            .map_err(|_| AuthorityError::policy("question_answer_invalid"))?,
        collation,
    )?;
    if record
        .outcome_receipt_json
        .as_deref()
        .is_some_and(|existing| existing != raw)
    {
        return Err(AuthorityError::policy("authority_decision_conflict"));
    }
    if record.outcome_receipt_json.is_none() {
        repo.record_question_followup(&record.request_ref, &raw, &clock())?;
    }
    let stored = repo
        .find_ref(&record.request_ref)?
        .ok_or_else(|| AuthorityError::policy("authority_request_not_found"))?;
    projection::decision(&stored)
}

impl PrincipalAuthority {
    pub async fn settle_question_followup(&self, request_ref: String) -> AuthorityResult<()> {
        self.in_lane(move |repo| repo.settle_question_followup(&request_ref))
            .await
    }
}
