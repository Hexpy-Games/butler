//! AnimatedNumber.showcase.tsx.
use butler_ds::ui::animated_number::{AnimatedNumber, grouped};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Cross, Inline, Space, Stack};
use butler_ds::ui::typo::{Role, Tone, Typo, Wrap};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

const SEQUENCE: [f64; 4] = [128., 36460., 1284., 1_284_000.];

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Count to a new value",
            render: counting,
        },
        Story {
            name: "Inline in text",
            render: inline_in_text,
        },
    ]
}

/// `Intl.NumberFormat(locale, { notation: "compact" })` for the showcase values.
pub(super) fn compact(lang: Lang, value: f64) -> String {
    let tiers: [(f64, &str); 3] = match lang {
        Lang::En => [(1e9, "B"), (1e6, "M"), (1e3, "K")],
        Lang::Ko => [(1e8, "억"), (1e4, "만"), (1e3, "천")],
    };
    for (floor, suffix) in tiers {
        if value >= floor {
            let scaled = value / floor;
            let text = if scaled < 10. {
                format!("{scaled:.1}")
            } else {
                format!("{scaled:.0}")
            };
            return format!("{}{suffix}", text.trim_end_matches(".0"));
        }
    }
    format!("{value:.0}")
}

fn counting(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let step = window.use_keyed_state("animated-step", cx, |_, _| 0usize);
    let at = *step.read(cx);
    let (tokens, requests, replay) = lang.pick(
        ("Input tokens", "Requests", "Replay"),
        ("입력 토큰", "요청", "다시 재생"),
    );
    let metric = |id: &'static str, value: f64, compacted: bool, caption: &'static str| {
        Stack::new()
            .gap(Space::Xs)
            .child(
                AnimatedNumber::new(id, value)
                    .role(Role::MetricValue)
                    .format(move |v| {
                        if compacted {
                            compact(lang, v)
                        } else {
                            grouped(v)
                        }
                    }),
            )
            .child(Typo::caption(caption).tone(Tone::Secondary))
    };
    Stack::new()
        .gap(Space::Md)
        .child(
            Inline::new()
                .gap(Space::Xl)
                .child(metric("animated-tokens", SEQUENCE[at], false, tokens))
                .child(metric(
                    "animated-requests",
                    SEQUENCE[(at + 2) % SEQUENCE.len()],
                    true,
                    requests,
                )),
        )
        .child(
            Inline::new().child(
                Button::new("animated-replay")
                    .variant(Variant::Outline)
                    .size(Size::Sm)
                    .text(replay)
                    .on_click(move |_, _, cx| {
                        step.update(cx, |step, cx| {
                            *step = (*step + 1) % SEQUENCE.len();
                            cx.notify();
                        });
                    }),
            ),
        )
        .into_any_element()
}

fn inline_in_text(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let tokens = lang.pick("Input tokens", "입력 토큰");
    Stack::row()
        // The space between the words: gpui drops a trailing space from a text item's width.
        .gap(Space::Xs)
        .cross(Cross::Baseline)
        .child(Typo::body(tokens).wrap(Wrap::Nowrap))
        .child(AnimatedNumber::new("animated-inline", 36460.).role(Role::Body))
        .into_any_element()
}
