//! `userQuestions.ts` (`withQuestionAnswers`, 9e09cb276): answers occupy their own user row.
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::ui::source::wire::{
    AnsweredUserQuestions, MessageRecord, MessageRecordRole, UserQuestionResponse,
};

/// `withQuestionAnswers`: replace follow-ups and insert remaining answers before later messages.
pub(super) fn with_question_answers(
    messages: &[Arc<MessageRecord>],
    answers: &[AnsweredUserQuestions],
) -> Vec<Arc<MessageRecord>> {
    let completed: Vec<_> = answers
        .iter()
        .filter(|answer| matches!(answer.response, UserQuestionResponse::Answered { .. }))
        .collect();
    if completed.is_empty() {
        return messages.to_vec();
    }
    let ids: HashSet<_> = messages.iter().map(|message| message.id.as_str()).collect();
    let followups: HashMap<_, _> = completed
        .iter()
        .map(|answer| (answer.followup_message_id.as_str(), *answer))
        .collect();
    let mut remaining: Vec<_> = completed
        .into_iter()
        .filter(|answer| !ids.contains(answer.followup_message_id.as_str()))
        .collect();
    remaining.sort_by(|left, right| {
        timestamp(&left.updated_at)
            .zip(timestamp(&right.updated_at))
            .map_or(Ordering::Equal, |(left, right)| left.cmp(&right))
    });
    let mut next = remaining.into_iter().peekable();
    let mut result = Vec::new();
    for message in messages {
        while next.peek().is_some_and(|answer| {
            timestamp(&answer.updated_at)
                .zip(timestamp(message.created_at.as_deref().unwrap_or_default()))
                .is_some_and(|(answer, message)| answer <= message)
        }) {
            if let Some(answer) = next.next() {
                insert(&mut result, answer);
            }
        }
        if let Some(answer) = followups.get(message.id.as_str()) {
            summarize(&mut result, answer, message.created_at.as_deref());
            let mut row = (**message).clone();
            row.text.clear();
            row.question_answer = Some((*answer).clone());
            result.push(Arc::new(row));
        } else {
            result.push(message.clone());
        }
    }
    for answer in next {
        insert(&mut result, answer);
    }
    result
}

/// Reuse the shell's RFC3339 date parser; invalid dates compare like JavaScript NaN.
fn timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis())
}

/// `withQuestionAnswers.summarize`: attach to the nearest unsummarized assistant in the turn.
fn summarize(
    result: &mut Vec<Arc<MessageRecord>>,
    answer: &AnsweredUserQuestions,
    at: Option<&str>,
) {
    let summary = answer.questions.questions.clone();
    if let Some(message) = result.iter_mut().rev().find(|message| {
        message.role == MessageRecordRole::Assistant
            && message.turn_id.as_deref() == Some(answer.source_turn_id.as_str())
            && message.question_summary.is_none()
    }) {
        Arc::make_mut(message).question_summary = Some(summary);
    } else {
        let mut row = row(answer, MessageRecordRole::Assistant, at);
        row.id = format!("question-{}", answer.request_ref);
        row.status = Some("delivered".into());
        row.question_summary = Some(summary);
        result.push(Arc::new(row));
    }
}

/// `withQuestionAnswers.insert`: a summary followed by a distinct user answer row.
fn insert(result: &mut Vec<Arc<MessageRecord>>, answer: &AnsweredUserQuestions) {
    summarize(result, answer, Some(&answer.updated_at));
    let mut row = row(answer, MessageRecordRole::User, Some(&answer.updated_at));
    row.question_answer = Some(answer.clone());
    result.push(Arc::new(row));
}

/// The minimal synthetic `MessageRecord` shape used by Electron's `withQuestionAnswers`.
fn row(answer: &AnsweredUserQuestions, role: MessageRecordRole, at: Option<&str>) -> MessageRecord {
    MessageRecord {
        id: answer.request_ref.clone(),
        role,
        text: String::new(),
        turn_id: Some(answer.source_turn_id.clone()),
        created_at: at.map(str::to_owned),
        updated_at: at.map(str::to_owned),
        canon_proposals: None,
        quiet: None,
        failure_notice: None,
        initiated: None,
        question_answer: None,
        question_summary: None,
        system_event_kind: None,
        content_parts: None,
        chat_id: None,
        plan_document: None,
        answer_blocks: None,
        attachments: None,
        artifacts: None,
        changed_files: None,
        work_blocks: None,
        turn_activity_rows: None,
        status: None,
        delivery_state: None,
        limitation_codes: None,
        limitations: None,
        safe_error_code: None,
        retryable: None,
        incomplete: None,
        retry_mode: None,
        retry_with_current_controls: None,
        cursor: None,
    }
}

/// Electron `canonProposalMessages.ts`: attach each turn's anchors to its last assistant.
pub(super) fn with_canon_proposals(
    messages: &[Arc<MessageRecord>],
    anchors: &[crate::ui::source::wire::CanonProposalAnchor],
) -> Vec<Arc<MessageRecord>> {
    let mut by_turn: HashMap<&str, Vec<_>> = HashMap::new();
    for anchor in anchors {
        by_turn
            .entry(&anchor.turn_id)
            .or_default()
            .push(anchor.clone());
    }
    let mut result = messages.to_vec();
    for (turn, anchors) in by_turn {
        if let Some(message) = result.iter_mut().rev().find(|message| {
            message.role == MessageRecordRole::Assistant && message.turn_id.as_deref() == Some(turn)
        }) {
            let mut row = (**message).clone();
            row.canon_proposals = Some(anchors);
            *message = Arc::new(row);
        }
    }
    result
}

/// Electron `useConversationMessages.ts`: answers, then proposal anchors, before collapse.
pub(super) fn with_view_receipts(
    view: &crate::ui::source::wire::SessionView,
) -> Vec<Arc<MessageRecord>> {
    let messages = with_question_answers(
        &view.messages,
        view.question_answers.as_deref().unwrap_or_default(),
    );
    with_canon_proposals(
        &messages,
        view.canon_proposals.as_deref().unwrap_or_default(),
    )
}
