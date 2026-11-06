//! Skeleton.showcase.tsx.
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::skeleton::{Height, RowsShape, Shape, Skeleton, SkeletonRows, Width};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Pending turn lines",
            render: |_, _, _| {
                Skeleton::new("skeleton-turn")
                    .lines(3)
                    .height(Height::Line)
                    .into_any_element()
            },
        },
        Story {
            name: "Settings list rows",
            render: |_, _, _| {
                let mut rows = Stack::new().gap(Space::Sm);
                for index in 0..4 {
                    rows = rows.child(
                        Skeleton::new(format!("skeleton-row-{index}"))
                            .height(Height::Row)
                            .width(Width::Full),
                    );
                }
                rows.into_any_element()
            },
        },
        Story {
            name: "Widths, heights and shapes",
            render: shapes,
        },
        Story {
            name: "SkeletonRows: list and field shapes",
            render: |_, _, _| {
                Stack::new()
                    .gap(Space::Lg)
                    .child(
                        SkeletonRows::new("skeleton-list")
                            .rows(3)
                            .shape(RowsShape::List),
                    )
                    .child(
                        SkeletonRows::new("skeleton-field")
                            .rows(2)
                            .shape(RowsShape::Field),
                    )
                    .into_any_element()
            },
        },
        Story {
            name: "Reduced motion: the sheen stops, the fill stays",
            render: reduced,
        },
    ]
}

fn shapes(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .child(
            Skeleton::new("skeleton-title")
                .height(Height::Title)
                .width(Width::Half),
        )
        .child(
            Skeleton::new("skeleton-line")
                .height(Height::Line)
                .width(Width::ThreeQuarters),
        )
        .child(
            Skeleton::new("skeleton-ch")
                .height(Height::Line)
                .width(Width::Ch(24.)),
        )
        .child(
            Skeleton::new("skeleton-pill")
                .height(Height::Control)
                .width(Width::Third)
                .shape(Shape::Pill),
        )
        .child(
            Skeleton::new("skeleton-circle")
                .height(Height::Control)
                .shape(Shape::Circle),
        )
        .into_any_element()
}

/// The `data-motion="reduced"` scope: the sheen rests and only the static fill shows.
fn reduced(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .child(
            Skeleton::new("skeleton-still-lines")
                .lines(3)
                .height(Height::Line)
                .still(),
        )
        .child(
            Skeleton::new("skeleton-still-row")
                .height(Height::Row)
                .width(Width::Full)
                .still(),
        )
        .into_any_element()
}
