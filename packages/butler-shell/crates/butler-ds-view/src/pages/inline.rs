//! Inline.showcase.tsx.
use butler_ds::ui::Icon;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Inline, Space};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;
use crate::standins::tag;

fn chips(lang: Lang) -> [&'static str; 7] {
    lang.pick(
        [
            "Design system",
            "Typography",
            "Layout",
            "Settings",
            "Dashboard",
            "Korean copy",
            "Tabular numbers",
        ],
        [
            "디자인 시스템",
            "타이포그래피",
            "레이아웃",
            "설정",
            "대시보드",
            "한국어 문구",
            "고정폭 숫자",
        ],
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Chip row",
            render: chip_row,
        },
        Story {
            name: "Icon and metadata",
            render: metadata,
        },
        Story {
            name: "Separate row gap",
            render: row_gap,
        },
        Story {
            name: "No wrap",
            render: no_wrap,
        },
    ]
}

fn chip_row(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    Inline::new()
        .children(chips(lang).map(|chip| tag(chip, cx)))
        .into_any_element()
}

fn metadata(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    Inline::new()
        .gap(Space::Xs)
        .child(icon(Icon::GitBranch, IconSize::Xs, ds))
        .child(Typo::caption("feature/ds-step-4"))
        .child(Typo::caption("·").tone(Tone::Tertiary))
        .child(
            Typo::caption(lang.pick("Updated 2 minutes ago", "2분 전 업데이트"))
                .tone(Tone::Secondary),
        )
        .into_any_element()
}

fn row_gap(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Inline::new()
        .gap(Space::Lg)
        .row_gap(Space::Sm)
        .children(chips(lang).map(Typo::body))
        .into_any_element()
}

fn no_wrap(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    Inline::new()
        .wrap(false)
        .children(chips(lang).into_iter().take(3).map(|chip| tag(chip, cx)))
        .into_any_element()
}
