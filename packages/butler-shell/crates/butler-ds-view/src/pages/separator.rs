//! Separator.showcase.tsx.
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::separator::{Separator, SeparatorTone};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Line, spacing and vertical",
            render: basics,
        },
        Story {
            name: "Between usage rows",
            render: usage_rows,
        },
        Story {
            name: "Tones",
            render: tones,
        },
        Story {
            name: "Space none (statistic sources)",
            render: space_none,
        },
    ]
}

fn basics(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .child(Typo::body(lang.pick("Line", "선")))
        .child(Separator::new().tone(SeparatorTone::Default))
        .child(Typo::body(lang.pick("Spacing only", "간격만")))
        .child(Separator::new().no_line().space(Space::Md))
        .child(
            Stack::row()
                .cross(Cross::Center)
                .gap(Space::Sm)
                .child(Typo::body(lang.pick("Vertical", "세로")))
                .child(Separator::new().vertical().tone(SeparatorTone::Accent))
                .child(Typo::body(lang.pick("Accent", "강조"))),
        )
        .into_any_element()
}

fn usage_rows(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let rows = lang.pick(
        [
            ("Input tokens", "1.2M"),
            ("Output tokens", "184K"),
            ("Cached tokens", "912K"),
        ],
        [
            ("입력 토큰", "1.2M"),
            ("출력 토큰", "184K"),
            ("캐시된 토큰", "912K"),
        ],
    );
    let mut stack = Stack::new().gap(Space::None);
    for (index, (name, value)) in rows.into_iter().enumerate() {
        let mut row = Stack::new().gap(Space::None);
        if index > 0 {
            row = row.child(Separator::new().space(Space::Md));
        }
        stack = stack.child(
            row.child(
                Stack::row()
                    .justify(Justify::Between)
                    .gap(Space::Md)
                    .child(Typo::body(name))
                    .child(Typo::body(value).tone(Tone::Secondary)),
            ),
        );
    }
    stack.into_any_element()
}

fn tones(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let tones = [
        ("default", SeparatorTone::Default),
        ("strong", SeparatorTone::Strong),
        ("muted", SeparatorTone::Muted),
        ("accent", SeparatorTone::Accent),
    ];
    Stack::new()
        .gap(Space::Xs)
        .children(tones.map(|(name, tone)| {
            Stack::new()
                .gap(Space::None)
                .child(Typo::caption(name).tone(Tone::Secondary))
                .child(Separator::new().tone(tone))
        }))
        .into_any_element()
}

fn space_none(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Stack::new()
        .gap(Space::Md)
        .child(Separator::new().space(Space::None))
        .child(Typo::caption(lang.pick("3 sources", "출처 3개")))
        .into_any_element()
}
