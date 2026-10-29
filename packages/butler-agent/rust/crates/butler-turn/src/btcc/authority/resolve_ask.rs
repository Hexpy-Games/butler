//! Chat settlements reuse the deferred-answer receipt lane; approvals stay click-only.
use super::contracts::{AuthorityError, AuthorityResult, PrincipalAuthority, RequestDecision};
use super::questions::{UserQuestionAnswer, UserQuestionResponse, UserQuestions};
use crate::btcc::guided_turn::GuidedExecutionPolicy;
use crate::btcc::{PolicyRole, TurnRecord};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveAsk {
    pub ask_id: String,
    pub outcome: String,
    pub answer: Option<String>,
    pub quote: String,
}

impl PrincipalAuthority {
    pub async fn resolve_ask(
        &self,
        turn: &TurnRecord,
        has_other_tool_result: bool,
        input: ResolveAsk,
    ) -> AuthorityResult<Value> {
        if let Some(result) = guard(turn, has_other_tool_result, &input) {
            return Ok(result);
        }
        let owner = turn.session_id.clone();
        let now = (self.clock)();
        self.in_lane(move |repo| {
            let Some(reference) = input.ask_id.strip_prefix("question:") else {
                return Ok(not_open("unavailable"));
            };
            let Some(record) = repo.find_ref(reference)? else {
                return Ok(not_open("unavailable"));
            };
            if record.owner_session_id != owner {
                return Ok(not_open("unavailable"));
            }
            if record.capability != "ask_user" {
                return Ok(refusal(
                    "approval_card_only",
                    "Approvals are settled only on their card. Tell the user it is waiting there.",
                ));
            }
            if record.close_reason.is_some()
                || record.outcome_receipt_json.is_some()
                || record.decision != RequestDecision::Modified
                || record
                    .private_alternative_input
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<UserQuestionResponse>(s).ok())
                    != Some(UserQuestionResponse::Deferred)
            {
                return Ok(not_open(&state(&record)));
            }
            let receipt = receipt(&record.normalized_input_json, &input)?;
            repo.settle_deferred_question(&owner, reference, &receipt.to_string(), &now)?;
            Ok(json!({"ok":true,"ask_id":input.ask_id,"state":"resolved_in_chat"}))
        })
        .await
    }
}

pub fn guard(turn: &TurnRecord, has_other_tool_result: bool, input: &ResolveAsk) -> Option<Value> {
    let delegated = GuidedExecutionPolicy::from_turn(turn, "")
        .map(|policy| policy.role != PolicyRole::Butler || policy.subsession.is_some())
        .unwrap_or(true);
    if delegated
        || turn.wake_identity.is_some()
        || turn.context.get("scheduleRun").is_some()
        || turn.context.get("subsessionResult").is_some()
        || turn.context.get("messageOrigin").and_then(Value::as_str) == Some("question_followup")
        || turn
            .original_message_id
            .starts_with("worker-result-message:")
    {
        return Some(refusal(
            "not_user_turn",
            "Only the user's own message can settle an ask. Leave it open.",
        ));
    }
    if input.ask_id.starts_with("approval:") {
        return Some(refusal(
            "approval_card_only",
            "Approvals are settled only on their card. Tell the user it is waiting there.",
        ));
    }
    if has_other_tool_result {
        return Some(refusal(
            "untrusted_context",
            "Settle asks before reading outside content in this turn. Leave it open; the user can answer on the card or in their next message.",
        ));
    }
    let quote = normalized(&input.quote);
    if quote.is_empty() || !normalized(&turn.original_message).contains(&quote) {
        return Some(refusal(
            "quote_not_found",
            "quote is not in the user's current message. Quote their own words, or ask if the reply is unclear.",
        ));
    }
    if input.ask_id.starts_with("canon:") {
        return (!(matches!(input.outcome.as_str(), "accepted" | "declined")
            && input.answer.is_none()))
        .then(|| {
            refusal(
                "invalid_outcome",
                "Use accepted or declined without answer.",
            )
        });
    }
    if !matches!(
        (
            input.outcome.as_str(),
            input.answer.as_deref().filter(|s| !s.trim().is_empty())
        ),
        ("answered", Some(_)) | ("dropped", None)
    ) {
        return Some(refusal(
            "invalid_outcome",
            "Use answered with an answer, or dropped without one.",
        ));
    }
    None
}

fn receipt(questions: &str, input: &ResolveAsk) -> AuthorityResult<Value> {
    if input.outcome == "dropped" {
        return Ok(json!({"status":"dismissed","resolved_by":"chat","quote":input.quote}));
    }
    let answer = input.answer.as_deref().filter(|s| !s.trim().is_empty());
    if input.outcome != "answered" || answer.is_none() {
        return Err(AuthorityError::policy("invalid_outcome"));
    }
    let questions: UserQuestions = serde_json::from_str(questions)
        .map_err(|_| AuthorityError::policy("authority_request_corrupt"))?;
    // A chat answer settles the whole card once, retaining its question ids.
    let response = UserQuestionResponse::Answered {
        answers: questions
            .questions
            .into_iter()
            .enumerate()
            .map(|(index, q)| UserQuestionAnswer {
                id: q.id,
                selected: Vec::new(),
                custom: answer.filter(|_| index == 0).map(str::to_owned),
                skipped: index != 0,
            })
            .collect(),
    };
    Ok(
        json!({"status":"resolved_in_chat","resolved_by":"chat","quote":input.quote,"response":response}),
    )
}

fn normalized(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn state(record: &super::contracts::AuthorityRecord) -> String {
    if record.close_reason.is_some() {
        return "closed".into();
    }
    record
        .outcome_receipt_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|receipt| {
            receipt
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "open".into())
}
fn not_open(state: &str) -> Value {
    refusal(
        "ask_not_open",
        &format!("This ask is no longer open (now {state}). Do not settle it again."),
    )
}
fn refusal(code: &str, message: &str) -> Value {
    json!({"ok":false,"error":{"code":code,"message":message}})
}
