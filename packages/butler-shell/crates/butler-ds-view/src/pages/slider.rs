//! Slider.showcase.tsx.
use butler_ds::ui::layout::{Justify, Space, Stack};
use butler_ds::ui::slider::Slider;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::{Story, probe};
use crate::copy::Lang;

struct Copy {
    context: &'static str,
    compaction: &'static str,
    tokens: &'static str,
    locked: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            context: "Context limit",
            compaction: "Compact at",
            tokens: "tokens",
            locked: "Set by the provider",
        },
        Copy {
            context: "컨텍스트 한도",
            compaction: "압축 시점",
            tokens: "토큰",
            locked: "제공자가 정합니다",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Token budget",
            render: |lang, window, cx| token("slider-token", false, lang, window, cx),
        },
        Story {
            name: "Percent",
            render: percent,
        },
        Story {
            name: "Disabled",
            render: |lang, window, cx| token("slider-disabled", true, lang, window, cx),
        },
    ]
}

/// `Intl.NumberFormat` for en-US and ko-KR: groups of three digits.
fn grouped(value: f64) -> String {
    let digits = format!("{value:.0}");
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// A controlled value held in the page's state.
fn held(
    id: &'static str,
    initial: f64,
    window: &mut Window,
    cx: &mut App,
) -> (f64, impl Fn(f64, &mut Window, &mut App) + 'static) {
    let state = window.use_keyed_state(id, cx, move |_, _| initial);
    let value = *state.read(cx);
    (value, move |next, _: &mut Window, cx: &mut App| {
        state.update(cx, |value, cx| {
            *value = next;
            cx.notify();
        });
    })
}

/// A controlled slider over a token budget (TokenInputControl adds the exact input).
fn token(
    id: &'static str,
    disabled: bool,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let (value, change) = held(id, 285_000., window, cx);
    let mut slider = Slider::new(id, value, 1000., 1_000_000.)
        .step(1000.)
        .on_value_change(change);
    if disabled {
        slider = slider.disabled();
    }
    let mut stack = Stack::new()
        .gap(Space::Xs)
        .child(
            Stack::row()
                .justify(Justify::Between)
                .child(Typo::label(c.context))
                .child(
                    Typo::caption(format!("{} {}", grouped(value), c.tokens)).tone(Tone::Secondary),
                ),
        )
        .child(slider);
    if disabled {
        stack = stack.child(Typo::caption(c.locked).tone(Tone::Tertiary));
    }
    stack
        .child(probe(format!("value-{id}-{value:.0}")))
        .into_any_element()
}

/// 0-100 with a percent readout (PercentInputControl adds the exact input).
fn percent(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (value, change) = held("slider-percent", 80., window, cx);
    Stack::new()
        .gap(Space::Xs)
        .child(
            Stack::row()
                .justify(Justify::Between)
                .child(Typo::label(c.compaction))
                .child(Typo::caption(format!("{value:.0}%")).tone(Tone::Secondary)),
        )
        .child(Slider::new("slider-percent", value, 0., 100.).on_value_change(change))
        .child(probe(format!("value-percent-{value:.0}")))
        .into_any_element()
}
