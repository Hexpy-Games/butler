//! ScrollArea.showcase.tsx.
use butler_ds::ui::layout::{Box, Radius, Space, Stack, Surface};
use butler_ds::ui::scroll::{Axis, Bleed, MaxHeight, MinHeight, ScrollArea};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;
use crate::standins::tag;

struct Copy {
    row: fn(usize) -> String,
    tags: [&'static str; 8],
    hint: &'static str,
    column: &'static str,
    item: fn(usize) -> String,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            row: |n| {
                format!("Turn {n}: read the settings pages and summarized the section headers.")
            },
            tags: [
                "Token pages",
                "Motion",
                "States matrix",
                "Patterns",
                "Icons",
                "Overview",
                "Recipes",
                "Search",
            ],
            hint: "Scroll: the edge that clips content fades; the fade disappears at the boundary.",
            column: "Column edge",
            item: |n| format!("Section {n}"),
        },
        Copy {
            row: |n| format!("턴 {n}: 설정 페이지를 읽고 섹션 헤더를 요약했습니다."),
            tags: [
                "토큰 페이지",
                "모션",
                "상태 매트릭스",
                "패턴",
                "아이콘",
                "개요",
                "레시피",
                "검색",
            ],
            hint: "스크롤하면 내용이 잘리는 가장자리가 흐려지고, 끝에 닿으면 흐림이 사라집니다.",
            column: "열 끝",
            item: |n| format!("섹션 {n}"),
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Content fits",
            render: |lang, _, _| column_rows("scroll-fits", 3, lang),
        },
        Story {
            name: "Content overflows",
            render: |lang, _, _| column_rows("scroll-overflows", 12, lang),
        },
        Story {
            name: "Vertical with edge fades",
            render: vertical,
        },
        Story {
            name: "Horizontal",
            render: horizontal,
        },
        Story {
            name: "Bleed into the inspector gutter",
            render: bleed,
        },
        Story {
            name: "Minimum height",
            render: minimum,
        },
    ]
}

/// Settings-nav shape: a full-width field above, filled rows below; both end on the column edge.
fn column_rows(id: &'static str, count: usize, lang: Lang) -> AnyElement {
    let c = copy(lang);
    let row = |text: String| {
        Box::new()
            .surface(Surface::Muted)
            .radius(Radius::Control)
            .padding_x(Space::Sm)
            .padding_y(Space::Xs)
            .child(Typo::body(text))
    };
    Stack::new()
        .gap(Space::Xs)
        .child(
            Box::new()
                .surface(Surface::Muted)
                .radius(Radius::Control)
                .padding_x(Space::Sm)
                .padding_y(Space::Xs)
                .child(Typo::caption(c.column).tone(Tone::Secondary)),
        )
        .child(
            ScrollArea::new(id)
                .max_height(MaxHeight::Xs)
                .probe(id)
                .child(
                    Stack::new()
                        .gap(Space::Xs)
                        .children((1..=count).map(|n| row((c.item)(n)))),
                ),
        )
        .into_any_element()
}

fn vertical(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Xs)
        .child(
            ScrollArea::new("scroll-vertical")
                .max_height(MaxHeight::Xs)
                .probe("scroll-vertical")
                .child(
                    Stack::new()
                        .gap(Space::Sm)
                        .children((1..=12).map(|n| Typo::body((c.row)(n)))),
                ),
        )
        .child(Typo::caption(c.hint).tone(Tone::Secondary))
        .into_any_element()
}

fn horizontal(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let tags: Vec<AnyElement> = c.tags.iter().map(|text| tag(*text, cx)).collect();
    ScrollArea::new("scroll-horizontal")
        .orientation(Axis::X)
        .probe("scroll-horizontal")
        .child(Stack::row().gap(Space::Xs).children(tags))
        .into_any_element()
}

fn bleed(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Box::new()
        .padding_x(Space::Sm)
        .child(
            ScrollArea::new("scroll-bleed")
                .bleed(Bleed::InlineEnd)
                .max_height(MaxHeight::Xs)
                .probe("scroll-bleed")
                .child(
                    Stack::new()
                        .gap(Space::Sm)
                        .children((1..=10).map(|n| Typo::body((c.row)(n)))),
                ),
        )
        .into_any_element()
}

fn minimum(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Box::new()
        .padding_x(Space::Sm)
        .child(
            ScrollArea::new("scroll-minimum")
                .bleed(Bleed::InlineEnd)
                .min_height(MinHeight::Xs)
                .child(
                    Stack::new()
                        .gap(Space::Sm)
                        .children((1..=2).map(|n| Typo::body((c.row)(n)))),
                ),
        )
        .into_any_element()
}
