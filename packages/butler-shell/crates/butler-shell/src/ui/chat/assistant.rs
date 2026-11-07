//! `AssistantMessageBody`, `AssistantReply`, footers, failure notice, retry, branch, trace.
mod branch;
mod failure;
mod footer;
pub(crate) mod hooks;
mod remote;
mod seed;

use butler_ds::ui::blocks::message_row::{MessageBubble, MessageBubbleAttachments};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::tag::Tag;
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, SharedString, Window,
};

use super::TranscriptCtx;
use super::activity::steward::steward_progress;
use super::activity::{is_general_chat, message_activity};
use super::answers::answer_blocks;
use super::files::message_files;
use super::message_markdown::message_markdown_in;
use crate::ui::i18n::{AssistantStrings, assistant};
use crate::ui::source::wire::{InitiatedOriginState, MessageRecord, MessageRecordRole};

pub(crate) use branch::assistant_branch_actions;
pub(crate) use failure::{
    can_retry_with_current_controls, message_retry_actions, message_trace_menu, retryable,
};
pub(crate) use footer::{FooterMeta, ResponseFooter, assistant_response_footer};
pub(crate) use hooks::AssistantHooks;
pub(crate) use seed::session_branch_seed;

/// The assistant body's copy for the app's language.
fn text(cx: &App) -> &'static AssistantStrings {
    assistant(Ds::get(cx).lang())
}

/// `isAssistantFailureNoticeMessage`
fn failure_message(message: &MessageRecord) -> bool {
    message.role == MessageRecordRole::Assistant
        && message.status.as_deref() == Some("failed")
        && message
            .safe_error_code
            .as_ref()
            .is_some_and(|code| !code.is_empty())
}

fn initiated_kind(message: &MessageRecord) -> Option<&str> {
    message
        .initiated
        .as_ref()
        .map(|origin| origin.kind.as_str())
}

/// The assistant message: its body, then the response footer once it settled
/// (`MessageContent`).
pub(crate) fn assistant_message(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Vec<AnyElement> {
    let (body, steward) = assistant_body(msg, t, window, cx);
    let mut parts = vec![body];
    let running = t.live_message == Some(msg.id.as_str())
        || matches!(msg.status.as_deref(), Some("streaming" | "pending"));
    if !running {
        parts.extend(response_footer(msg, t, steward, window, cx));
    }
    parts
}

/// `AssistantResponseFooter` of a settled answer, with its branch and trace actions.
fn response_footer(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    steward: bool,
    window: &mut Window,
    cx: &mut App,
) -> Vec<AnyElement> {
    let actions: Vec<AnyElement> = assistant_branch_actions(msg, t, window, cx)
        .into_iter()
        .chain(message_trace_menu(msg, cx))
        .collect();
    let kind = initiated_kind(msg);
    let failed_notice = msg.failure_notice.is_some();
    assistant_response_footer(
        ResponseFooter {
            id: &msg.id,
            bubble: is_general_chat(msg.chat_id.as_deref()),
            time_only: matches!(kind, Some("approval_needed" | "work_failed")),
            copy_text: &msg.text,
            meta: t.footer_meta.get(&msg.id),
            status: if failed_notice {
                Some("failed")
            } else {
                msg.status.as_deref()
            },
            suppress_terminal_status: kind == Some("work_failed")
                || steward
                || (msg.incomplete == Some(true) && !failed_notice),
            actions: (!actions.is_empty()).then(|| {
                Stack::row()
                    .gap(Space::None)
                    .children(actions)
                    .into_any_element()
            }),
        },
        cx,
    )
}

/// The assistant message body, and whether it shows steward progress.
fn assistant_body(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> (AnyElement, bool) {
    let mut steward = false;
    let bubble = is_general_chat(msg.chat_id.as_deref());
    let failure = failure_message(msg);
    let mut parts: Vec<AnyElement> = Vec::new();
    if !bubble {
        parts.extend(message_activity(msg, t, window, cx));
    }
    if let Some(origin) = msg
        .initiated
        .as_ref()
        .filter(|origin| origin.kind == "canon_step")
    {
        let step = text(cx).canon_step(
            origin.plan_title.as_deref(),
            origin.epic_title.as_deref().unwrap_or(""),
        );
        parts.push(Typo::caption(step).tone(Tone::Secondary).into_any_element());
    }
    if bubble {
        bubble_body(msg, t, failure, (&mut parts, &mut steward), window, cx);
    } else {
        answer_reply(msg, t, failure, (&mut parts, &mut steward), window, cx);
        parts.extend(attachments(msg, t, window, cx));
    }
    let body = Stack::new()
        .gap(Space::Lg)
        .children(parts)
        .into_any_element();
    (body, steward)
}

/// The `general` chat: the answer in a bubble, steward progress, then files and cards under it.
fn bubble_body(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    failure: bool,
    (parts, steward): (&mut Vec<AnyElement>, &mut bool),
    window: &mut Window,
    cx: &mut App,
) {
    if failure {
        parts.push(failure::failure_notice(msg, t, cx));
    } else if !msg.text.trim().is_empty() || initiated_kind(msg) == Some("work_failed") {
        parts.push(
            MessageBubble::new()
                .child(reply_text(msg, cx))
                .into_any_element(),
        );
    }
    let progress = steward_progress(msg, t, window, cx);
    *steward = progress.is_some();
    parts.extend(progress);
    let mut under = MessageBubbleAttachments::new();
    if !failure {
        under = under.children(blocks(msg, t, window, cx));
    }
    under = under.children(attachments(msg, t, window, cx));
    parts.push(under.into_any_element());
}

/// `AnswerReply`: the failure notice or the reply, with steward progress under it when there is
/// some.
fn answer_reply(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    failure: bool,
    (parts, steward): (&mut Vec<AnyElement>, &mut bool),
    window: &mut Window,
    cx: &mut App,
) {
    let mut reply = Vec::new();
    if failure {
        reply.push(failure::failure_notice(msg, t, cx));
    } else {
        reply.push(reply_text(msg, cx));
        reply.extend(blocks(msg, t, window, cx));
    }
    match steward_progress(msg, t, window, cx) {
        Some(progress) => {
            *steward = true;
            reply.push(progress);
            parts.push(
                Stack::new()
                    .gap(Space::Md)
                    .children(reply)
                    .into_any_element(),
            );
        }
        None => parts.extend(reply),
    }
}

/// `AnswerBlocks` of the message, when it has any.
fn blocks(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let sets = msg
        .answer_blocks
        .as_deref()
        .filter(|sets| !sets.is_empty())?;
    answer_blocks(sets, t, window, cx)
}

/// `AssistantReplyText`: the work-failure line, else the message's markdown.
fn reply_text(msg: &MessageRecord, cx: &mut App) -> AnyElement {
    if let Some(origin) = msg
        .initiated
        .as_ref()
        .filter(|origin| origin.kind == "work_failed")
    {
        let retrying = origin.state == Some(InitiatedOriginState::Retrying);
        return Typo::body(text(cx).work_failed(retrying, origin.reason_code.as_deref()))
            .wrap(Wrap::Anywhere)
            .into_any_element();
    }
    message_markdown_in(
        ElementId::from(SharedString::from(format!("reply-{}", msg.id))),
        SharedString::from(msg.text.clone()),
        msg.status.as_deref() == Some("streaming"),
        msg.attachments.as_deref().unwrap_or_default(),
        cx,
    )
}

/// `AssistantAttachments`: question summary, the stopped or incomplete tag, the failure notice
/// of the turn, files, and the unavailable-attachment tag.
fn attachments(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Vec<AnyElement> {
    let copy = text(cx);
    let mut parts = Vec::new();
    for question in msg.question_summary.iter().flatten() {
        parts.push(
            Stack::new()
                .gap(Space::None)
                .child(Typo::caption(question.eyebrow.clone()).tone(Tone::Tertiary))
                .child(Typo::body(question.title.clone()).wrap(Wrap::Anywhere))
                .into_any_element(),
        );
    }
    let incomplete = msg.incomplete == Some(true);
    if msg.status.as_deref() == Some("cancelled") || incomplete {
        let label = if incomplete {
            copy.incomplete
        } else {
            copy.stopped
        };
        parts.push(
            Tag::new(SharedString::from(format!("status-{}", msg.id)), label).into_any_element(),
        );
    }
    if let Some(notice) = msg.failure_notice.as_deref() {
        parts.push(failure::failure_notice(notice, t, cx));
    }
    parts.extend(message_files(msg, t, window, cx));
    if msg
        .limitation_codes
        .iter()
        .flatten()
        .any(|code| code == "message_file_unavailable")
    {
        parts.push(
            Tag::new(
                SharedString::from(format!("unavailable-{}", msg.id)),
                copy.attachment_unavailable,
            )
            .into_any_element(),
        );
    }
    parts
}
