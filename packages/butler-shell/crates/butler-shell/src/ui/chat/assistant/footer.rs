//! `AssistantResponseFooter`. (`AnswerDraftFooter` needs the `answer_blocks.*` draft events, which
//! the shell's event stream does not carry.)
use butler_ds::ui::blocks::message_row::{MessageFooter, MessageStatusLabel, MessageStatusRow};
use butler_ds::ui::context::Ds;
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::thinking_mark::{ButlerThinkingMark, MarkTheme};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString};

use super::text;

const NON_TERMINAL_STATUSES: [&str; 10] = [
    "queued",
    "pending",
    "accepted",
    "thinking",
    "streaming",
    "running",
    "waiting_for_form",
    "waiting_for_tool",
    "retrying",
    "cancelling",
];

/// `AssistantFooterMeta`: the worked-for duration and the finish time, already formatted.
#[derive(Clone)]
pub(crate) struct FooterMeta {
    pub(crate) duration_label: Option<String>,
    pub(crate) time_label: Option<String>,
}

/// `AssistantResponseFooter`'s props.
pub(crate) struct ResponseFooter<'a> {
    pub(crate) id: &'a str,
    pub(crate) bubble: bool,
    pub(crate) time_only: bool,
    /// The text the copy button writes.
    pub(crate) copy_text: &'a str,
    pub(crate) meta: Option<&'a FooterMeta>,
    pub(crate) status: Option<&'a str>,
    pub(crate) suppress_terminal_status: bool,
    pub(crate) actions: Option<AnyElement>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Terminal {
    Complete,
    Failed,
    Cancelled,
}

fn terminal_status(status: Option<&str>, cx: &App) -> Option<(&'static str, Terminal)> {
    let copy = text(cx);
    match status {
        Some("failed") => Some((copy.answer_failed, Terminal::Failed)),
        Some("cancelled") => Some((copy.answer_stopped, Terminal::Cancelled)),
        Some(status) if NON_TERMINAL_STATUSES.contains(&status) => None,
        _ => Some((copy.answer_done, Terminal::Complete)),
    }
}

fn mark_theme(cx: &App) -> MarkTheme {
    if Ds::get(cx).dark() {
        MarkTheme::Dark
    } else {
        MarkTheme::Light
    }
}

/// The status row: the mark, then the label as a caption (`AssistantStatusLabel`, idle).
fn status_row(id: SharedString, label: &'static str, cx: &App) -> AnyElement {
    let mark =
        ButlerThinkingMark::new(SharedString::from(format!("{id}-mark"))).theme(mark_theme(cx));
    MessageStatusRow::new()
        .flush()
        .child(MessageStatusLabel::new(id, mark).child(Typo::caption(label)))
        .into_any_element()
}

/// The footer of a settled answer: copy, actions, worked-for time and finish time, then the
/// terminal status row. Both are direct children of the assistant body (`flush`).
pub(crate) fn assistant_response_footer(footer: ResponseFooter, cx: &App) -> Vec<AnyElement> {
    let copy = text(cx);
    let terminal = terminal_status(footer.status, cx);
    // A live answer has not finished: no worked-for duration or finish time yet.
    let live = footer
        .status
        .is_some_and(|status| NON_TERMINAL_STATUSES.contains(&status));
    let settled = if live { None } else { footer.meta };
    let mut row = MessageFooter::new().flush();
    if !footer.time_only {
        row = row.child(
            CopyButton::new(
                SharedString::from(format!("copy-{}", footer.id)),
                copy.copy_message,
                copy.copied,
            )
            .text(footer.copy_text),
        );
        if let Some(actions) = footer.actions {
            row = row.child(actions);
        }
        if let Some(duration) = settled
            .filter(|_| !footer.bubble)
            .and_then(|meta| meta.duration_label.as_deref())
        {
            row = row.child(gpui::div().child(copy.worked_for(duration)));
        }
    }
    if let Some(time) = settled.and_then(|meta| meta.time_label.as_deref()) {
        row = row.child(Typo::text(time.to_owned()).tabular());
    }
    let mut parts = vec![row.into_any_element()];
    if let Some((label, state)) = terminal
        && !footer.suppress_terminal_status
        && !(footer.bubble && state == Terminal::Complete)
    {
        parts.push(status_row(
            SharedString::from(format!("terminal-status-{}", footer.id)),
            label,
            cx,
        ));
    }
    parts
}
