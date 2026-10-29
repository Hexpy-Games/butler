//! Message rows (blocks/MessageRow, WorkActivityBlock, TurnActivityTimeline).
use std::time::{Duration, Instant};

use gpui::{Animation, AnimationExt as _, AnyElement, Div, FontWeight, div, prelude::*, px};

use super::markdown_view;
use crate::ui::motion::{BASE, decelerate};
use crate::ui::source::{ActivityItem, Message, Role};
use crate::ui::theme::{Theme, alpha, typo};
use crate::ui::widgets::{icon, text};

pub(super) struct RowCtx<'a> {
    pub(super) theme: &'a Theme,
    pub(super) column: f32,
    pub(super) activity_open: bool,
    /// When the message arrived live (it plays the insert motion once).
    pub(super) born: Option<Instant>,
}

/// One virtualized row: the message plus its row padding (user 18px, assistant 26px).
pub(super) fn row(
    ix: usize,
    msg: &Message,
    cx: &RowCtx,
    activity_toggle: Option<AnyElement>,
) -> AnyElement {
    let user = msg.role == Role::User;
    let body = if user {
        user_bubble(msg, cx)
    } else if matches!(msg.role, Role::Other(_)) {
        div()
            .text_size(px(typo::BODY.0))
            .line_height(px(typo::BODY.1))
            .text_color(cx.theme.text3)
            .child(msg.text.clone())
    } else {
        assistant(msg, cx, activity_toggle)
    };
    let row = div()
        .w(px(cx.column))
        .pb(px(if user { 18. } else { 26. }))
        .child(body);
    match cx.born {
        Some(born) if born.elapsed() < Duration::from_millis(400) => row
            .with_animation(
                ("enter", ix),
                Animation::new(BASE).with_easing(decelerate()),
                |el, t| el.opacity(t).relative().top(px(4. * (1. - t))),
            )
            .into_any_element(),
        _ => row.into_any_element(),
    }
}

fn user_bubble(msg: &Message, cx: &RowCtx) -> Div {
    let max = (cx.column * 0.68).min(440.);
    div().flex().justify_end().child(
        div()
            .max_w(px(max))
            .px(px(10.))
            .py(px(6.))
            .rounded(px(14.))
            .bg(cx.theme.user_bubble)
            .text_size(px(typo::DOC.0))
            .line_height(px(typo::DOC.1))
            .text_color(cx.theme.text)
            .child(msg.text.clone()),
    )
}

fn assistant(msg: &Message, cx: &RowCtx, activity_toggle: Option<AnyElement>) -> Div {
    let theme = cx.theme;
    let mut col = div().flex().flex_col().gap(px(16.)).pt(px(2.)).pb(px(4.));
    if let Some(toggle) = activity_toggle.filter(|_| !msg.activity.is_empty()) {
        let mut timeline = div()
            .flex()
            .flex_col()
            .items_start()
            .gap(px(4.))
            .child(toggle);
        if cx.activity_open {
            let n = msg.activity.len();
            let mut list = div().flex().flex_col().gap(px(8.)).pt(px(4.));
            for (i, item) in msg.activity.iter().enumerate() {
                list = list.child(activity_block(item, theme, i + 1 < n));
            }
            timeline = timeline.child(list);
        }
        col = col.child(timeline);
    }
    if msg.streaming && msg.text.is_empty() {
        col.child(status_row(theme))
    } else {
        col.child(markdown_view::render(&msg.text, theme))
    }
}

/// The turn's activity disclosure header (current while it runs, complete after): an inline button, secondary text + chevron.
pub(super) fn activity_header(msg: &Message, open: bool, hovered: bool, theme: &Theme) -> Div {
    let strings = theme.strings;
    // A running turn's activity is current; a finished one's is complete.
    let phase = if msg.streaming {
        strings.working
    } else {
        strings.complete
    };
    let label = strings.activity_history(msg.streaming, phase, msg.activity.len());
    let mut t = text(label, typo::BODY, FontWeight::NORMAL, theme.text2);
    if hovered {
        t = t.underline();
    }
    let chevron = if open {
        "chevron-down"
    } else {
        "chevron-right"
    };
    div()
        .flex()
        .items_center()
        .gap(px(5.))
        .cursor_pointer()
        .child(t)
        .child(icon(chevron, 14., theme.text2))
}

fn tool_chip(icon_name: &'static str, title: gpui::SharedString, theme: &Theme) -> Div {
    let muted = alpha(theme.text3, 0.78);
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .px(px(8.))
        .py(px(5.))
        .border_1()
        .border_color(theme.line)
        .rounded(px(8.))
        .bg(theme.tool_chip)
        .child(
            div()
                .size(px(20.))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(icon_name, 14., theme.text3)),
        )
        .child(text(title, typo::BODY, FontWeight::NORMAL, muted))
}

fn activity_block(item: &ActivityItem, theme: &Theme, connected: bool) -> Div {
    let mut tools = div().flex().flex_col().items_start().gap(px(8.));
    for tool in &item.tools {
        tools = tools.child(tool_chip(tool.icon, tool.title.clone(), theme));
    }
    let line = div()
        .absolute()
        .left(px(15.))
        .top(px(8.))
        .bottom(px(if connected { -24. } else { 2. }))
        .w(px(1.))
        .bg(alpha(theme.line, 0.82));
    let marker = div()
        .absolute()
        .left(px(12.))
        .top(px(8.))
        .size(px(7.))
        .rounded_full()
        .border_1()
        .border_color(theme.line_strong)
        .bg(theme.surface);
    let mut content = div().flex().flex_col().gap(px(8.)).child(text(
        item.title.clone(),
        typo::BODY,
        FontWeight::NORMAL,
        theme.text2,
    ));
    if !item.tools.is_empty() {
        content = content.child(tools);
    }
    div()
        .relative()
        .pl(px(44.))
        .child(line)
        .child(marker)
        .child(content)
}

/// While a reply waits for its first token: an 18px live mark and "working", breathing.
fn status_row(theme: &Theme) -> impl IntoElement {
    let dot = div().size(px(8.)).rounded_full().bg(theme.text);
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .child(
            div()
                .size(px(18.))
                .flex()
                .items_center()
                .justify_center()
                .child(dot),
        )
        .child(text(
            theme.strings.working,
            typo::BODY,
            FontWeight::NORMAL,
            theme.text2,
        ))
        .with_animation(
            "status-breathe",
            Animation::new(Duration::from_millis(1250)).repeat(),
            |el, t| el.opacity(0.55 + 0.45 * (1. - (t * std::f32::consts::TAU).cos()) / 2.),
        )
}
