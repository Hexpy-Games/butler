//! `MessageItem`, `VirtualMessageRow`, `MessageContent`.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::message_avatar_block::{AvatarRole, MessageAvatarBlock};
use butler_ds::ui::blocks::message_row::{Entering, MessageRow, Role, Tone};
use butler_ds::ui::blocks::question_answer_card::{
    Answer, Labels, Question, QuestionAnswerCard, QuestionKind, Variant,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::context_menu::{ContextMenu, ContextMenuContent, Item};
use butler_ds::ui::selectable::Selection;
use gpui::{
    AnyElement, App, ClipboardItem, IntoElement as _, ParentElement as _, SharedString, Window, div,
};

use super::TranscriptCtx;
use super::content::message_content;
use super::user::user_footer;
use crate::ui::i18n::transcript;
use crate::ui::source::wire::{
    AnsweredUserQuestions, MessageRecord, MessageRecordRole, MessageRecordSystemEventKind,
    UserQuestion, UserQuestionAnswer, UserQuestionKind, UserQuestionOptionsItem,
    UserQuestionOptionsItemKind, UserQuestionResponse,
};
use crate::ui::widgets::anchor;

/// One transcript message: the DS MessageRow by role, with the copy context menu.
pub(crate) fn message_row(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    if let Some(question) = &msg.question_answer
        && let UserQuestionResponse::Answered { answers } = &question.response
    {
        return question_card(msg, question, answers, cx);
    }
    virtual_message_row(msg, t, window, cx)
}

/// `MessageItem`: an answered question is its own user-side card.
fn question_card(
    msg: &MessageRecord,
    question: &AnsweredUserQuestions,
    answers: &[UserQuestionAnswer],
    cx: &App,
) -> AnyElement {
    let skipped = answers.iter().all(|a| a.skipped);
    let text = transcript(Ds::get(cx).lang());
    let labels = Labels {
        answered: text.answered.into(),
        skipped: text.skipped.into(),
        message: text.answered_in_message.into(),
    };
    let questions = &question.questions.questions;
    QuestionAnswerCard::new(row_id(msg), question_props(questions))
        .answers(answer_props(questions, answers))
        .variant(if skipped {
            Variant::Skipped
        } else {
            Variant::Answered
        })
        .labels(labels)
        .into_any_element()
}

/// Whether the row just arrived (`enteringIds`), or resolves a queued bubble in place.
fn entering(msg: &MessageRecord, t: &TranscriptCtx) -> Entering {
    t.entering.get(&msg.id).copied().unwrap_or(Entering::No)
}

/// Concrete answers only: the card has its own Skip and free input.
fn answer_options(question: &UserQuestion) -> Vec<&UserQuestionOptionsItem> {
    if question.kind == UserQuestionKind::Text {
        return Vec::new();
    }
    question
        .options
        .iter()
        .filter(|o| {
            o.kind
                .as_ref()
                .is_none_or(|k| *k == UserQuestionOptionsItemKind::Answer)
        })
        .collect()
}

/// `questionProps`.
fn question_props(questions: &[UserQuestion]) -> Vec<Question> {
    questions
        .iter()
        .map(|q| {
            let options = answer_options(q);
            let kind = match q.kind {
                _ if options.is_empty() => QuestionKind::Text,
                UserQuestionKind::Multi => QuestionKind::Multi,
                _ => QuestionKind::Single,
            };
            Question {
                id: q.id.clone().into(),
                header: q.eyebrow.clone().into(),
                kind,
                options: options
                    .iter()
                    .map(|o| SharedString::from(o.label.clone()))
                    .collect(),
            }
        })
        .collect()
}

/// `answerProps`.
fn answer_props(questions: &[UserQuestion], answers: &[UserQuestionAnswer]) -> Vec<Answer> {
    answers
        .iter()
        .map(|a| {
            let options = questions
                .iter()
                .find(|q| q.id == a.id)
                .map(answer_options)
                .unwrap_or_default();
            Answer {
                id: a.id.clone().into(),
                selected: a
                    .selected
                    .iter()
                    .filter_map(|id| options.iter().position(|o| &o.id == id))
                    .collect(),
                text: SharedString::default(),
                other: a.custom.clone().unwrap_or_default().into(),
                skipped: a.skipped,
            }
        })
        .collect()
}

fn row_id(msg: &MessageRecord) -> SharedString {
    SharedString::from(format!("message-{}", msg.id))
}

/// `isCompactionMessage`: event provenance, not text.
fn is_compaction(msg: &MessageRecord) -> bool {
    msg.role == MessageRecordRole::SystemEvent
        && matches!(
            msg.system_event_kind,
            Some(
                MessageRecordSystemEventKind::ContextCompactionStarted
                    | MessageRecordSystemEventKind::ContextCompactionCompleted
            )
        )
}

/// `visibleSystemMessageText`.
pub(super) fn visible_system_message_text(msg: &MessageRecord, cx: &App) -> String {
    let text = transcript(Ds::get(cx).lang());
    match (&msg.system_event_kind, is_compaction(msg)) {
        (Some(MessageRecordSystemEventKind::ContextCompactionStarted), true) => {
            text.compacting.into()
        }
        (_, true) => text.compacted.into(),
        _ => msg.text.clone(),
    }
}

/// `isAssistantFailureNoticeMessage`.
fn is_failure_notice(msg: &MessageRecord) -> bool {
    msg.role == MessageRecordRole::Assistant
        && msg.status.as_deref() == Some("failed")
        && msg
            .safe_error_code
            .as_deref()
            .is_some_and(|c| !c.is_empty())
}

fn message_tone(msg: &MessageRecord) -> Tone {
    if is_failure_notice(msg) {
        Tone::Failed
    } else if msg.status.as_deref() == Some("pending") {
        Tone::Pending
    } else {
        Tone::Complete
    }
}

fn row_role(role: &MessageRecordRole) -> Role {
    match role {
        MessageRecordRole::Assistant => Role::Assistant,
        MessageRecordRole::User => Role::User,
        MessageRecordRole::SystemEvent => Role::SystemEvent,
        MessageRecordRole::ToolSummary => Role::ToolSummary,
        MessageRecordRole::Automation => Role::Automation,
        MessageRecordRole::System | MessageRecordRole::Unknown => Role::System,
    }
}

/// `VirtualMessageRow`: the DS MessageRow inside the copy ContextMenu.
fn virtual_message_row(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let selection = Selection::new(
        SharedString::from(format!("message-select-{}", msg.id)),
        window,
        cx,
    );
    let compaction = is_compaction(msg);
    let mut row = MessageRow::new(row_id(msg), row_role(&msg.role))
        .selection(selection.clone())
        .tone(message_tone(msg))
        .entering(entering(msg, t));
    if msg.role == MessageRecordRole::Assistant && msg.chat_id.as_deref() == Some("general") {
        row = row.bubble();
    }
    if msg.role == MessageRecordRole::User {
        row = row.footer(user_footer(msg, cx));
    }
    if compaction {
        row = row.compaction_event();
    }
    if msg.role == MessageRecordRole::System && !compaction {
        row = row.avatar(MessageAvatarBlock::new().role(AvatarRole::System));
    }
    let row = row.children(message_content(msg, t, window, cx));
    let menu = ContextMenu::new(
        SharedString::from(format!("message-menu-{}", msg.id)),
        window,
        cx,
    );
    let text = visible_system_message_text(msg, cx);
    let label = transcript(Ds::get(cx).lang()).copy;
    let content = menu.content(
        ContextMenuContent::new().child(Item::new(label).icon(Icon::Copy).on_select(
            move |_, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(
                    selection.text(cx).unwrap_or_else(|| text.clone()),
                ));
            },
        )),
        window,
        cx,
    );
    div()
        .child(menu.trigger(anchor(div(), &format!("message-{}", msg.id)).child(row)))
        .child(content)
        .into_any_element()
}
