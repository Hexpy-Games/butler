//! MetricCard.showcase.tsx: values that count on replay, and a static value.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::metric_card::{MetricCard, MetricGrid, Trend};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Inline, Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::animated_number::compact;
use super::{Story, probe};
use crate::copy::Lang;
use butler_ds::ui::context::Ds;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Counting values",
            render: counting,
        },
        Story {
            name: "Static value",
            render: fixed,
        },
    ]
}

fn counting(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let round = window.use_keyed_state("metric-round", cx, |_, _| 0usize);
    let at = *round.read(cx) % 3;
    let (requests, tokens, sessions, replay) = lang.pick(
        (
            "Model requests",
            "Input tokens",
            "Active sessions",
            "Replay",
        ),
        ("모델 요청", "입력 토큰", "활성 세션", "다시 재생"),
    );
    let activity = icon(Icon::Activity, IconSize::Md, Ds::get(cx));
    Stack::new()
        .gap(Space::Md)
        .child(
            MetricGrid::new("metric-counting")
                .child(
                    MetricCard::number("m-requests", [42., 128., 1290.][at], requests)
                        .format(move |v| compact(lang, v)),
                )
                .child(
                    MetricCard::number("m-tokens", [36460., 184_200., 912_000.][at], tokens)
                        .format(move |v| compact(lang, v)),
                )
                .child(
                    MetricCard::number("m-sessions", [3., 7., 12.][at], sessions)
                        .trend(Trend::Up)
                        .change("+12%")
                        .icon(activity),
                ),
        )
        .child(
            Inline::new().child(
                Button::new("metric-replay")
                    .variant(Variant::Outline)
                    .size(Size::Sm)
                    .text(replay)
                    .on_click(move |_, _, cx| {
                        round.update(cx, |round, cx| {
                            *round += 1;
                            cx.notify();
                        });
                    }),
            ),
        )
        .child(probe(format!("metric-round-{at}")))
        .into_any_element()
}

fn fixed(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let requests = lang.pick("Model requests", "모델 요청");
    MetricCard::text("m-static", "1.2K", requests).into_any_element()
}
