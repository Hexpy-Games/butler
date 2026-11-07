//! `MessageItem`, `VirtualMessageRow`, `MessageContent`.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::message_avatar_block::{AvatarRole, MessageAvatarBlock};
use butler_ds::ui::blocks::message_row::{MessageFooter, MessageRow, Role, Tone};
use butler_ds::ui::blocks::question_answer_card::{
    Answer, Labels, Question, QuestionAnswerCard, QuestionKind, Variant,
};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::context_menu::{ContextMenu, ContextMenuContent, Item};
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, App, ClipboardItem, IntoElement as _, ParentElement as _, SharedString, Window,
    div,
};

use super::TranscriptCtx;
use super::assistant::assistant_body;
use super::user::user_body;
use crate::ui::source::wire::{
    AnsweredUserQuestions, MessageRecord, MessageRecordRole, MessageRecordSystemEventKind,
    UserQuestion, UserQuestionAnswer, UserQuestionKind, UserQuestionOptionsItem,
    UserQuestionOptionsItemKind, UserQuestionResponse,
};
use crate::ui::widgets::anchor;

/// One transcript message: the DS MessageRow by role, with the copy context menu.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) fn message_row(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let korean = Ds::get(cx).lang() == Lang::Ko;
    if let Some(question) = &msg.question_answer
        && let UserQuestionResponse::Answered { answers } = &question.response
    {
        return question_card(msg, question, answers, korean);
    }
    virtual_message_row(msg, t, korean, window, cx)
}

/// `MessageItem`: an answered question is its own user-side card.
fn question_card(
    msg: &MessageRecord,
    question: &AnsweredUserQuestions,
    answers: &[UserQuestionAnswer],
    korean: bool,
) -> AnyElement {
    let skipped = answers.iter().all(|a| a.skipped);
    let labels = if korean {
        Labels {
            answered: "답변함".into(),
            skipped: "건너뜀".into(),
            message: "메시지로 답변함".into(),
        }
    } else {
        Labels::default()
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

/// Concrete answers only: the card has its own Skip and free input.
fn answer_options(question: &UserQuestion) -> Vec<&UserQuestionOptionsItem> {
    if question.kind == UserQuestionKind::Text {
        return Vec::new();
    }
    question
        .options
        .iter()
        .filter(|o| o.kind.as_ref().is_none_or(|k| *k == UserQuestionOptionsItemKind::Answer))
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
fn visible_system_message_text(msg: &MessageRecord, korean: bool) -> String {
    match (&msg.system_event_kind, is_compaction(msg), korean) {
        (Some(MessageRecordSystemEventKind::ContextCompactionStarted), true, false) => {
            "Context automatically compacting".into()
        }
        (Some(MessageRecordSystemEventKind::ContextCompactionStarted), true, true) => {
            "컨텍스트 자동 압축 중".into()
        }
        (_, true, false) => "Context automatically compacted".into(),
        (_, true, true) => "컨텍스트 자동 압축 완료".into(),
        _ => msg.text.clone(),
    }
}

/// `isAssistantFailureNoticeMessage`.
fn is_failure_notice(msg: &MessageRecord) -> bool {
    msg.role == MessageRecordRole::Assistant
        && msg.status.as_deref() == Some("failed")
        && msg.safe_error_code.as_deref().is_some_and(|c| !c.is_empty())
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
    korean: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let compaction = is_compaction(msg);
    let mut row = MessageRow::new(row_id(msg), row_role(&msg.role)).tone(message_tone(msg));
    if msg.role == MessageRecordRole::Assistant && msg.chat_id.as_deref() == Some("general") {
        row = row.bubble();
    }
    if msg.role == MessageRecordRole::User {
        row = row.footer(user_message_footer(msg, korean));
    }
    if compaction {
        row = row.compaction_event();
    }
    if msg.role == MessageRecordRole::System && !compaction {
        row = row.avatar(MessageAvatarBlock::new().role(AvatarRole::System));
    }
    let row = row.child(message_content(msg, t, korean, window, cx));
    let menu = ContextMenu::new(SharedString::from(format!("message-menu-{}", msg.id)), window, cx);
    let text = visible_system_message_text(msg, korean);
    let label = if korean { "복사" } else { "Copy" };
    let content = menu.content(
        ContextMenuContent::new().child(Item::new(label).icon(Icon::Copy).on_select(
            move |_, cx| cx.write_to_clipboard(ClipboardItem::new_string(text.clone())),
        )),
        window,
        cx,
    );
    div()
        .child(menu.trigger(anchor(div(), &format!("message-{}", msg.id)).child(row)))
        .child(content)
        .into_any_element()
}

/// `MessageContent`: the body by role.
fn message_content(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    korean: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    match msg.role {
        MessageRecordRole::Assistant => assistant_body(msg, t, window, cx),
        MessageRecordRole::User => user_body(msg, t, window, cx),
        _ => div()
            .child(SharedString::from(visible_system_message_text(msg, korean)))
            .into_any_element(),
    }
}

/// `UserMessageFooter`: the sent time and the copy button.
fn user_message_footer(msg: &MessageRecord, korean: bool) -> MessageFooter {
    let sent = msg
        .created_at
        .as_deref()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok());
    let (copy, copied) = if korean {
        ("메시지 복사", "복사됨")
    } else {
        ("Copy message", "Copied")
    };
    let mut footer = MessageFooter::new();
    if let Some(sent) = sent {
        footer = footer.child(Typo::text(sent.format("%H:%M").to_string()).tabular());
    }
    footer.child(
        CopyButton::new(
            SharedString::from(format!("message-copy-{}", msg.id)),
            copy,
            copied,
        )
        .text(msg.text.clone()),
    )
}
