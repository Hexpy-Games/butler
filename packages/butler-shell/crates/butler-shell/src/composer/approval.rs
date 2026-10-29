//! The authority card shown in place of the composer input (ComposerDecisionPanel +
//! ComposerAuthorityDecisionSurface): what is asked, the agent's exact action, details, and
//! the decision buttons.
use gpui::{
    AnimationExt as _, Context, FontWeight, IntoElement, SharedString, div, prelude::*, px,
};

use super::{Composer, ComposerEvent};
use crate::motion::{mix, spring_fast};
use crate::source::{AuthorityCard, Decision};
use crate::theme::{Theme, hex, rgba, typo};
use crate::widgets::{hover_listener, icon, text};

fn risk_tag(t: &Theme, label: SharedString) -> impl IntoElement {
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

/// Button size="sm" (28px) with the composer radius; secondary or primary.
fn button(
    c: &Composer,
    request: &SharedString,
    decision: Decision,
    cx: &mut Context<Composer>,
) -> impl IntoElement {
    let t = &c.theme;
    let (id, label, primary) = match decision {
        Decision::Deny => ("deny", "거절", false),
        Decision::AllowOnce => ("allow", "이번만 허용", true),
    };
    let key = SharedString::from(id);
    let lit = c.hover.is(id);
    let (bg, fg, border) = if primary {
        (t.send_bg, t.send_fg, gpui::transparent_black())
    } else {
        (t.secondary_bg, t.text, t.secondary_border)
    };
    let hover_bg = if primary {
        mix(t.send_bg, gpui::white(), 0.12)
    } else {
        t.selection_strong
    };
    let request = request.clone();
    div()
        .id(key.clone())
        .h(px(28.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded_full()
        .border_1()
        .border_color(border)
        .cursor_pointer()
        .on_hover(hover_listener(&key, cx))
        .on_click(cx.listener(move |_, _, _, cx| {
            cx.emit(ComposerEvent::Answer(request.clone(), decision));
        }))
        .child(text(label, typo::LABEL, FontWeight::NORMAL, fg))
        .with_spring(key, spring_fast(lit), move |el, v| {
            el.bg(mix(bg, hover_bg, v))
        })
}

pub(super) fn panel(
    c: &Composer,
    card: &AuthorityCard,
    cx: &mut Context<Composer>,
) -> impl IntoElement {
    let t = c.theme.clone();
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
                .child(icon("terminal", 14., t.text2)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(text(
                    card.kind.clone(),
                    typo::CAPTION,
                    FontWeight::NORMAL,
                    t.text3,
                ))
                .child(text(
                    card.action.clone(),
                    typo::LABEL,
                    FontWeight::MEDIUM,
                    t.text,
                )),
        )
        .children(card.risk.clone().map(|risk| risk_tag(&t, risk)));
    let mut details = div()
        .pl(px(34.))
        .pr(px(12.))
        .pt(px(8.))
        .pb(px(12.))
        .flex()
        .flex_col();
    for line in &card.details {
        details = details.child(text(
            line.clone(),
            typo::CAPTION,
            FontWeight::NORMAL,
            t.text2,
        ));
    }
    let actions = div()
        .flex()
        .justify_end()
        .items_center()
        .gap(px(8.))
        .p(px(8.))
        .border_t_1()
        .border_color(t.glass_divider)
        .child(button(c, &card.request, Decision::Deny, cx))
        .child(button(c, &card.request, Decision::AllowOnce, cx));
    div()
        .flex()
        .flex_col()
        .child(subject)
        .child(details)
        .child(actions)
}
