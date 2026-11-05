//! Layout.showcase.tsx: the layout item props.
use butler_ds::ui::layout::{
    AlignSelf, Basis, Columns, Cross, Grid, GridItem, Justify, MaxWidth, MinWidth, Space, Span,
    Stack, StackItem, WithItem as _,
};
use butler_ds::ui::typo::{TextAlign, Tone, Typo, Wrap};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;
use crate::standins::{input_placeholder, tag};

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Basis scale",
            render: basis,
        },
        Story {
            name: "Label and value row",
            render: label_value,
        },
        Story {
            name: "Align self and span",
            render: align_span,
        },
        Story {
            name: "Field width",
            render: field_width,
        },
        Story {
            name: "Capped item width",
            render: capped,
        },
    ]
}

fn basis(_: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    Stack::new()
        .gap(Space::Xs)
        .children(
            [
                ("xs", Basis::Xs),
                ("sm", Basis::Sm),
                ("md", Basis::Md),
                ("lg", Basis::Lg),
            ]
            .map(|(name, basis)| {
                Stack::row().child(
                    StackItem::new()
                        .basis(basis)
                        .child(tag(format!("basis={name}"), cx)),
                )
            }),
        )
        .into_any_element()
}

const LABEL_KO: &str = "이번 달 제공자별 사용량과 남은 한도";
const LABEL_EN: &str = "Provider usage and remaining quota for this month";

fn label_value(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Stack::row()
        .justify(Justify::Between)
        .cross(Cross::Start)
        .gap(Space::Md)
        .wrap(true)
        .child(
            Typo::body(lang.pick(LABEL_EN, LABEL_KO))
                .grow()
                .basis(Basis::Md)
                .min_width(MinWidth::Zero),
        )
        .child(
            Typo::body("12,480")
                .align(TextAlign::End)
                .tabular()
                .wrap(Wrap::Nowrap),
        )
        .into_any_element()
}

fn align_span(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    Grid::new("layout-align-span")
        .columns(Columns::fixed(2))
        .gap(Space::Sm)
        .item(GridItem::new().span(Span::Full).child(tag("span=full", cx)))
        .item(
            GridItem::new()
                .align_self(AlignSelf::End)
                .child(tag("alignSelf=end", cx)),
        )
        .child(Typo::body(lang.pick(LABEL_EN, LABEL_KO)))
        .into_any_element()
}

fn field_width(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let field = lang.pick("Search chats", "대화 검색");
    let period = lang.pick("Last 24 hours", "최근 24시간");
    Stack::row()
        .cross(Cross::Center)
        .justify(Justify::Between)
        .gap(Space::Md)
        .wrap(true)
        .child(
            StackItem::new()
                .grow()
                .basis(Basis::Md)
                .min_width(MinWidth::Zero)
                .max_width(MaxWidth::Field)
                .child(input_placeholder(field, cx)),
        )
        .child(tag(period, cx))
        .into_any_element()
}

fn capped(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Stack::row()
        .cross(Cross::Baseline)
        .justify(Justify::Between)
        .gap(Space::Sm)
        .child(
            Typo::caption("projects/butler-site/specs/design-system.md")
                .tone(Tone::Secondary)
                .grow()
                .basis(Basis::Zero)
                .min_width(MinWidth::Zero)
                .truncate(),
        )
        .child(
            Typo::caption("Working on the settings hierarchy and every page")
                .tone(Tone::Secondary)
                .max_width(MaxWidth::ThreeFifths)
                .truncate(),
        )
        .into_any_element()
}
