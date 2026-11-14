//! `UserMessageText`, `UserMessageFooter`.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::message_row::MessageFooter;
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::inline_reference::{InlineFlow, InlineReference};
use butler_ds::ui::selectable;
use butler_ds::ui::typo::{Typo, Wrap};
use chrono::{DateTime, Datelike, Local};
use gpui::{
    AnyElement, App, Entity, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, canvas, div,
};

use super::TranscriptCtx;
use crate::ui::i18n::transcript;
use crate::ui::source::wire::{MessageContentPart, MessageRecord};

/// `COLLAPSED_LINES`.
const COLLAPSED_LINES: usize = 5;
const COLLAPSED_HEIGHT_LINES: f32 = 5.;

/// The `expanded` and `overflowing` state of `UserMessageText`; `full` is the measured height.
struct State {
    expanded: bool,
    full: f32,
}

#[derive(IntoElement)]
struct UserMessageText {
    id: SharedString,
    text: SharedString,
    content_parts: Option<Vec<MessageContentPart>>,
}

/// The user message body.
pub(crate) fn user_body(
    msg: &MessageRecord,
    _t: &TranscriptCtx,
    _window: &mut Window,
    _cx: &mut App,
) -> AnyElement {
    UserMessageText {
        id: SharedString::from(format!("user-text-{}", msg.id)),
        text: SharedString::from(msg.text.clone()),
        content_parts: msg.content_parts.as_ref().map(|c| c.parts.clone()),
    }
    .into_any_element()
}

/// The text with its parts: session, project and document references are inline chips.
fn parts_flow(id: &str, parts: &[MessageContentPart], line: gpui::Pixels) -> AnyElement {
    let mut lines: Vec<(InlineFlow, bool)> = Vec::new();
    let mut current = (InlineFlow::new(), false);
    for (index, part) in parts.iter().enumerate() {
        let (icon, label) = match part {
            MessageContentPart::Text { text } => {
                for (n, segment) in text.split('\n').enumerate() {
                    if n > 0 {
                        lines.push(std::mem::replace(&mut current, (InlineFlow::new(), false)));
                    }
                    if !segment.is_empty() {
                        current = (current.0.text(segment.to_owned()), true);
                    }
                }
                continue;
            }
            MessageContentPart::SessionRef {
                titleSnapshot: title,
                ..
            } => (Icon::MessageSquare, title),
            MessageContentPart::ProjectRef {
                titleSnapshot: title,
                ..
            } => (Icon::Briefcase, title),
            MessageContentPart::ProjectSourceRef {
                titleSnapshot: title,
                ..
            } => (Icon::FileText, title),
        };
        let chip = InlineReference::mention(
            SharedString::from(format!("{id}-ref-{index}")),
            icon,
            label.clone(),
        );
        current = (current.0.reference(chip), true);
    }
    lines.push(current);
    div()
        .flex()
        .flex_col()
        .children(lines.into_iter().map(|(flow, filled)| {
            if filled {
                flow.into_any_element()
            } else {
                div().h(line).into_any_element()
            }
        }))
        .into_any_element()
}

impl UserMessageText {
    fn content(&self, clamp: bool, selectable: bool, line: gpui::Pixels) -> AnyElement {
        match &self.content_parts {
            Some(parts) => {
                let flow = parts_flow(&self.id, parts, line);
                if clamp {
                    div()
                        .overflow_hidden()
                        .max_h(line * COLLAPSED_HEIGHT_LINES)
                        .child(flow)
                        .into_any_element()
                } else {
                    flow
                }
            }
            None => {
                let text = Typo::text(self.text.clone()).wrap(Wrap::Pre);
                let text = if selectable { text.selectable() } else { text };
                if clamp {
                    text.line_clamp(COLLAPSED_LINES).into_any_element()
                } else {
                    text.into_any_element()
                }
            }
        }
    }

    /// The hidden copy of the whole text: its height tells whether the text overflows.
    fn measuring_copy(&self, state: &Entity<State>, line: gpui::Pixels) -> gpui::Div {
        let probe = state.clone();
        div()
            .absolute()
            .top_0()
            .left_0()
            .w_full()
            .invisible()
            .child(selectable::exclude(self.content(false, false, line)))
            .child(
                canvas(
                    move |bounds, _, cx| {
                        let height = f32::from(bounds.size.height);
                        probe.update(cx, |s, cx| {
                            if (s.full - height).abs() > 0.5 {
                                s.full = height;
                                cx.notify();
                            }
                        });
                    },
                    |_, (), _, _| {},
                )
                .absolute()
                .size_full(),
            )
    }
}

impl RenderOnce for UserMessageText {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = window.use_keyed_state(
            SharedString::from(format!("{}-state", self.id)),
            cx,
            |_, _| State {
                expanded: false,
                full: 0.,
            },
        );
        let line = window.text_style().line_height_in_pixels(window.rem_size());
        let (expanded, full) = {
            let s = state.read(cx);
            (s.expanded, s.full)
        };
        let overflowing = full > f32::from(line) * COLLAPSED_HEIGHT_LINES + 1.;
        let strings = transcript(Ds::get(cx).lang());
        let toggle = overflowing.then(|| {
            let state = state.clone();
            Button::new(SharedString::from(format!("{}-toggle", self.id)))
                .variant(Variant::Inline)
                .text(if expanded {
                    strings.show_less
                } else {
                    strings.show_more
                })
                .on_click(move |_, _, cx| {
                    state.update(cx, |s, cx| {
                        s.expanded = !s.expanded;
                        cx.notify();
                    });
                })
        });
        div()
            .child(
                div()
                    .relative()
                    .min_w_0()
                    .child(self.content(!expanded, true, line))
                    .child(self.measuring_copy(&state, line)),
            )
            .children(toggle)
    }
}

/// `formatClock`: hour and two-digit minute, with month and day when the time is not today and
/// the year when it is not this year.
pub(super) fn format_clock(date: &DateTime<Local>, lang: Lang, now: &DateTime<Local>) -> String {
    let (same_year, same_day) = (
        date.year() == now.year(),
        date.year() == now.year() && date.ordinal() == now.ordinal(),
    );
    let clock = match lang {
        Lang::Ko => date
            .format("%p %-I:%M")
            .to_string()
            .replace("AM", "오전")
            .replace("PM", "오후"),
        Lang::En => date.format("%-I:%M %p").to_string(),
    };
    let day = match (lang, same_year, same_day) {
        (_, _, true) => return clock,
        (Lang::Ko, true, _) => date.format("%-m월 %-d일").to_string(),
        (Lang::Ko, false, _) => date.format("%Y년 %-m월 %-d일").to_string(),
        (Lang::En, true, _) => date.format("%b %-d,").to_string(),
        (Lang::En, false, _) => date.format("%b %-d, %Y,").to_string(),
    };
    format!("{day} {clock}")
}

/// The footer under a user message: the send time and the copy button, in the row's footer
/// slot.
pub(crate) fn user_footer(msg: &MessageRecord, cx: &App) -> MessageFooter {
    let lang = Ds::get(cx).lang();
    let sent_at = msg
        .created_at
        .as_deref()
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok());
    let strings = transcript(lang);
    MessageFooter::new()
        .children(sent_at.map(|at| {
            let at = at.with_timezone(&Local);
            Typo::text(format_clock(&at, lang, &Local::now()))
                .tabular()
                .into_any_element()
        }))
        .child(
            CopyButton::new(
                SharedString::from(format!("copy-{}", msg.id)),
                strings.copy_message,
                strings.copied,
            )
            .text(msg.text.clone()),
        )
}
