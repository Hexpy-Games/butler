//! PageContainer.showcase.tsx: the four widths, and a container query (a grid whose columns
//! follow the page container's width, not the window's).
use butler_ds::ui::card::Card;
use butler_ds::ui::layout::{
    Border, Box, Columns, Grid, Preset, Radius, Responsive, Space, Stack, Surface,
};
use butler_ds::ui::page_container::{PageContainer, PageWidth};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    width: &'static str,
    main: &'static str,
    aside: &'static str,
    metric: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            width: "width",
            main: "Remaining work",
            aside: "Important materials",
            metric: "Open work",
        },
        Copy {
            width: "너비",
            main: "남은 작업",
            aside: "중요 자료",
            metric: "열린 작업",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Widths",
            render: widths,
        },
        Story {
            name: "Container query",
            render: container_query,
        },
    ]
}

fn widths(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let widths = [
        (PageWidth::Narrow, "narrow"),
        (PageWidth::Default, "default"),
        (PageWidth::Wide, "document"),
        (PageWidth::Full, "full"),
    ];
    Stack::new()
        .gap(Space::Sm)
        .children(widths.map(|(width, name)| {
            Box::new()
                .surface(Surface::Muted)
                .radius(Radius::Control)
                .child(
                    PageContainer::new().width(width).child(
                        Box::new()
                            .border(Border::Hairline)
                            .radius(Radius::Control)
                            .padding(Space::Sm)
                            .surface(Surface::Raised)
                            .child(
                                Typo::caption(format!("{}=\"{name}\"", c.width))
                                    .tone(Tone::Secondary),
                            ),
                    ),
                )
        }))
        .into_any_element()
}

fn container_query(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let responsive = |base, wide| {
        Columns::Responsive(Responsive {
            compact: None,
            base,
            wide: Some(wide),
        })
    };
    let metrics = Grid::new("pc-metrics")
        .columns(responsive(Preset::Fixed(2), Preset::Fixed(4)))
        .page_container()
        .gap(Space::Sm)
        .children([3, 7, 1, 12].map(|value| {
            Card::new(format!("pc-metric-{value}")).child(
                Stack::new()
                    .gap(Space::Xs)
                    .child(Typo::metric_value(value.to_string()).tabular())
                    .child(Typo::caption(c.metric).tone(Tone::Secondary)),
            )
        }));
    let panes = Grid::new("pc-panes")
        .columns(responsive(Preset::Fixed(1), Preset::MainAside))
        .page_container()
        .gap(Space::Md)
        .child(Card::new("pc-main").child(Typo::body(c.main)))
        .child(Card::new("pc-aside").child(Typo::body(c.aside)));
    PageContainer::new()
        .gutter(Space::None)
        .child(Stack::new().gap(Space::Md).child(metrics).child(panes))
        .into_any_element()
}
