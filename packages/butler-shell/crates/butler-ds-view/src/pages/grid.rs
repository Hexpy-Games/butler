//! Grid.showcase.tsx. The responsive stories use the grid's own width as the `page` container
//! (PageContainer with `gutter="none"` is exactly as wide as its grid).
use butler_ds::ui::card::Card;
use butler_ds::ui::layout::{Columns, Grid, GridItem, Preset, Responsive, Space, Span, Stack};
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

const LONG_VALUE: &str = "/Users/butler/Projects/workspace/packages/client/src/components/management/ProjectDocumentMarkdownContent.tsx";

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Auto-fit",
            render: auto_fit,
        },
        Story {
            name: "Span",
            render: span,
        },
        Story {
            name: "Responsive columns (page container)",
            render: responsive,
        },
        Story {
            name: "Card columns: compact 2 · base 3 · wide 4",
            render: card_columns,
        },
        Story {
            name: "Label / value rows",
            render: label_value,
        },
        Story {
            name: "Wide content (every preset)",
            render: wide_content,
        },
    ]
}

fn cell(id: String, text: String) -> Card {
    Card::new(id).child(Typo::body(text))
}

fn auto_fit(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let name = lang.pick("Cell", "셀");
    let mut grid = Grid::new("grid-auto-fit").gap(Space::Md);
    for index in 1..=4 {
        grid = grid.child(cell(format!("auto-fit-{index}"), format!("{name} {index}")));
    }
    grid.into_any_element()
}

fn span(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let name = lang.pick("Cell", "셀");
    let wide = lang.pick("Spans two columns", "두 칸 차지");
    let full = lang.pick("Spans the full row", "한 줄 전체 차지");
    Grid::new("grid-span")
        .columns(Columns::fixed(3))
        .gap(Space::Sm)
        .item(
            GridItem::new()
                .span(Span::Two)
                .child(cell("span-wide".into(), wide.into())),
        )
        .child(cell("span-1".into(), format!("{name} 1")))
        .item(
            GridItem::new()
                .span(Span::Full)
                .child(cell("span-full".into(), full.into())),
        )
        .child(cell("span-2".into(), format!("{name} 2")))
        .child(cell("span-3".into(), format!("{name} 3")))
        .child(cell("span-4".into(), format!("{name} 4")))
        .into_any_element()
}

fn responsive(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Grid::new("grid-responsive")
        .page_container()
        .columns(Columns::Responsive(Responsive {
            compact: None,
            base: Preset::Fixed(1),
            wide: Some(Preset::MainAside),
        }))
        .gap(Space::Md)
        .child(cell(
            "main".into(),
            lang.pick("Main content", "주요 내용").into(),
        ))
        .child(cell("aside".into(), lang.pick("Aside", "보조 영역").into()))
        .into_any_element()
}

fn card_columns(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let name = lang.pick("Cell", "셀");
    let mut grid = Grid::new("grid-card-columns")
        .page_container()
        .columns(Columns::Responsive(Responsive {
            compact: Some(2),
            base: Preset::Fixed(3),
            wide: Some(Preset::Fixed(4)),
        }))
        .gap(Space::Md);
    for index in 1..=6 {
        grid = grid.child(cell(format!("cards-{index}"), format!("{name} {index}")));
    }
    grid.into_any_element()
}

fn label_value(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let rows = [
        ("status", "draft"),
        ("owner", "mina"),
        ("updated", "2026-09-26"),
    ];
    Grid::new("grid-label-value-rows")
        .columns(Columns::fixed(1))
        .gap(Space::Xs)
        .children(rows.map(|(label, value)| {
            Grid::new(format!("grid-label-value-{label}"))
                .columns(Columns::LABEL_VALUE)
                .gap(Space::Sm)
                .child(Typo::caption(label).tone(Tone::Tertiary))
                .child(
                    Typo::caption(value)
                        .tone(Tone::Secondary)
                        .wrap(Wrap::Anywhere),
                )
        }))
        .into_any_element()
}

fn wide_content(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let presets = [
        ("1", Columns::fixed(1), 1),
        ("2", Columns::fixed(2), 2),
        ("3", Columns::fixed(3), 3),
        ("4", Columns::fixed(4), 4),
        ("6", Columns::fixed(6), 6),
        ("12", Columns::fixed(12), 12),
        ("auto-fit", Columns::AUTO_FIT, 3),
        ("auto-fill", Columns::AUTO_FILL, 3),
        ("main-aside", Columns::MAIN_ASIDE, 2),
        ("label-value", Columns::LABEL_VALUE, 2),
    ];
    Stack::new()
        .gap(Space::Md)
        .children(presets.map(|(name, columns, count)| {
            let mut grid = Grid::new(format!("grid-wide-{name}"))
                .columns(columns)
                .gap(Space::Xs);
            for _ in 0..count {
                grid = grid.child(Typo::caption(LONG_VALUE).tone(Tone::Secondary).truncate());
            }
            Stack::new()
                .gap(Space::Xs)
                .child(Typo::caption(name).tone(Tone::Tertiary))
                .child(grid)
        }))
        .into_any_element()
}
