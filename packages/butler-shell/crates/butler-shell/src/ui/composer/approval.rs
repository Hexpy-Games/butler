//! The authority card shown in place of the composer input (ComposerDecisionPanel +
//! ComposerAuthorityDecisionSurface): the kind, the agent's exact action (wrapping, never cut
//! or rephrased), its other examples and reason, and the decision buttons. Kinds this build
//! cannot decide keep their buttons disabled and say where to answer.
use gpui::{
    AnimationExt as _, AnyElement, Context, FontWeight, IntoElement, SharedString, div, prelude::*,
    px,
};

use super::{Composer, ComposerEvent};
use crate::ui::motion::{mix, spring_fast};
use crate::ui::source::{AuthorityCard, CardKind, Decision};
use crate::ui::theme::{Theme, hex, rgba, typo};
use crate::ui::widgets::{hover_listener, icon, text, tooltip};

fn risk_tag(t: &Theme, label: &'static str) -> impl IntoElement {
    let (border, bg, fg) = if t.dark {
        (
            rgba(230, 176, 0, 0.32),
            rgba(230, 176, 0, 0.12),
            hex(0x00ff_c71a),
        )
    } else {
        (hex(0x00ff_edb3), hex(0x00ff_f9e6), hex(0x008f_6500))
    };
    div()
        .flex_none()
        .h(px(22.))
        .px(px(8.))
        .flex()
        .items_center()
        .rounded_full()
        .border_1()
        .border_color(border)
        .bg(bg)
        .child(text(label, (12., 14.), FontWeight::NORMAL, fg))
}

/// The card's glyph and kind label.
fn kind(card: &AuthorityCard, t: &Theme) -> (&'static str, SharedString) {
    let s = t.strings;
    match &card.kind {
        CardKind::Command => ("terminal", s.category_command.into()),
        CardKind::ReviewedEffect => ("shield-check", s.category_effect.into()),
        CardKind::Question => ("message", s.question.into()),
        CardKind::Other(name) => ("shield-question", name.clone()),
    }
}

/// What the card is about: the exact action text, then the remaining examples (marked when the
/// gateway cut them) and the reason, all as sent.
fn lines(card: &AuthorityCard) -> (SharedString, Vec<SharedString>) {
    let action = card
        .approval
        .as_ref()
        .and_then(crate::ui::source::Approval::action);
    let mut details = Vec::new();
    if let Some(approval) = &card.approval {
        let cut = |i: usize| approval.examples_truncated.get(i).copied().unwrap_or(false);
        for (i, example) in approval.examples.iter().enumerate() {
            if Some(example) != action.as_ref() {
                details.push(if cut(i) {
                    format!("{example}…").into()
                } else {
                    example.clone()
                });
            }
        }
    }
    (action.unwrap_or_else(|| card.reason.clone()), details)
}

/// Button size="sm" (28px) with the composer radius. `on` is `None` when it is disabled.
fn button(
    c: &Composer,
    id: &'static str,
    label: &'static str,
    primary: bool,
    on: Option<ComposerEvent>,
    cx: &mut Context<Composer>,
) -> AnyElement {
    let t = &c.theme;
    let (bg, fg, border) = if primary {
        (t.send_bg, t.send_fg, gpui::transparent_black())
    } else {
        (t.secondary_bg, t.text, t.secondary_border)
    };
    let el = div()
        .id(id)
        .h(px(28.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded_full()
        .border_1();
    let Some(event) = on else {
        let label = text(label, typo::LABEL, FontWeight::NORMAL, t.text_disabled);
        return el
            .border_color(t.line)
            .bg(t.secondary_bg)
            .child(label)
            .into_any_element();
    };
    let key = SharedString::from(id);
    let hover_bg = if primary {
        mix(t.send_bg, gpui::white(), 0.12)
    } else {
        t.selection_strong
    };
    el.border_color(border)
        .cursor_pointer()
        .on_hover(hover_listener(&key, cx))
        .on_click(cx.listener(move |_, _, _, cx| cx.emit(event.clone())))
        .child(text(label, typo::LABEL, FontWeight::NORMAL, fg))
        .with_spring(key.clone(), spring_fast(c.hover.is(&key)), move |el, v| {
            el.bg(mix(bg, hover_bg, v))
        })
        .into_any_element()
}

fn actions(
    c: &Composer,
    card: &AuthorityCard,
    pending: bool,
    cx: &mut Context<Composer>,
) -> AnyElement {
    let t = c.theme.clone();
    let s = t.strings;
    let row = div()
        .flex()
        .justify_end()
        .items_center()
        .gap(px(8.))
        .p(px(8.))
        .border_t_1()
        .border_color(t.glass_divider);
    if !card.kind.decidable() {
        let off = button(c, "in-app", s.answer_in_app, false, None, cx);
        return row
            .child(
                div()
                    .id("answer-in-app")
                    .tooltip(tooltip(s.answer_in_app, &t))
                    .child(off),
            )
            .into_any_element();
    }
    let request = card.request.clone();
    let live = |event: ComposerEvent| (!pending).then_some(event);
    let modify = button(
        c,
        "modify",
        s.modify,
        false,
        live(ComposerEvent::Modify(Box::new(card.clone()))),
        cx,
    );
    let deny = button(
        c,
        "deny",
        s.deny,
        false,
        live(ComposerEvent::Answer(request.clone(), Decision::Deny)),
        cx,
    );
    let allow = button(
        c,
        "allow",
        s.allow_once,
        true,
        live(ComposerEvent::Answer(request, Decision::AllowOnce)),
        cx,
    );
    row.child(modify)
        .child(div().flex_1())
        .child(deny)
        .child(allow)
        .into_any_element()
}

pub(super) fn panel(
    c: &Composer,
    card: &AuthorityCard,
    pending: bool,
    cx: &mut Context<Composer>,
) -> impl IntoElement {
    let t = c.theme.clone();
    let (glyph, label) = kind(card, &t);
    let (action, details) = lines(card);
    let risk = card
        .approval
        .as_ref()
        .and_then(|a| a.risk)
        .map(|r| risk_tag(&t, t.strings.risk(r)));
    let subject = div()
        .flex()
        .items_start()
        .gap(px(8.))
        .pt(px(16.))
        .px(px(16.))
        .pb(px(4.))
        .child(
            div()
                .h(px(18.))
                .flex()
                .items_center()
                .child(icon(glyph, 14., t.text2)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(text(label, typo::CAPTION, FontWeight::NORMAL, t.text3))
                .child(crate::ui::exact_action::exact_action(action, &t, 1.)),
        )
        .children(risk);
    let mut more = div()
        .pl(px(34.))
        .pr(px(12.))
        .pt(px(8.))
        .pb(px(12.))
        .flex()
        .flex_col();
    for line in details {
        more = more.child(crate::ui::exact_action::exact_action(line, &t, 1.));
    }
    if card
        .approval
        .as_ref()
        .and_then(crate::ui::source::Approval::action)
        .is_some()
        && !card.reason.is_empty()
    {
        more = more.child(text(
            card.reason.clone(),
            typo::CAPTION,
            FontWeight::NORMAL,
            t.text2,
        ));
    }
    div()
        .flex()
        .flex_col()
        .child(subject)
        .child(more)
        .child(actions(c, card, pending, cx))
}
