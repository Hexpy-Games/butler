//! Box.showcase.tsx.
use butler_ds::ui::layout::{Border, Box, Columns, Elevation, Grid, Radius, Space, Stack, Surface};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, IntoElement as _, ParentElement as _};

use super::Story;
use crate::copy::Lang;

const SPACES: [(Space, &str); 7] = [
    (Space::None, "none"),
    (Space::Xs, "xs"),
    (Space::Sm, "sm"),
    (Space::Md, "md"),
    (Space::Lg, "lg"),
    (Space::Xl, "xl"),
    (Space::Xxl, "2xl"),
];
const SURFACES: [(Surface, &str); 6] = [
    (Surface::None, "none"),
    (Surface::Base, "base"),
    (Surface::Raised, "raised"),
    (Surface::RaisedOpaque, "raised-opaque"),
    (Surface::Overlay, "overlay"),
    (Surface::Muted, "muted"),
];
const BORDERS: [(Border, &str); 3] = [
    (Border::None, "none"),
    (Border::Hairline, "hairline"),
    (Border::Strong, "strong"),
];
const RADII: [(Radius, &str); 5] = [
    (Radius::None, "none"),
    (Radius::Control, "control"),
    (Radius::Panel, "panel"),
    (Radius::Popover, "popover"),
    (Radius::Pill, "pill"),
];

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Opaque raised card",
            render: |_, _, _| opaque(),
        },
        Story {
            name: "Padding scale",
            render: |lang, _, _| padding(lang),
        },
        Story {
            name: "Surfaces and borders",
            render: |lang, _, _| surfaces(lang),
        },
        Story {
            name: "Radius",
            render: |lang, _, _| radius(lang),
        },
        Story {
            name: "Inline-start padding (indented row)",
            render: |_, _, _| indented(),
        },
    ]
}

fn opaque() -> AnyElement {
    Box::new()
        .surface(Surface::RaisedOpaque)
        .elevation(Elevation::Card)
        .border(Border::Hairline)
        .radius(Radius::Panel)
        .padding(Space::Lg)
        .child(Typo::body("Opaque raised surface"))
        .into_any_element()
}

fn padding(lang: Lang) -> AnyElement {
    let content = lang.pick("Content", "내용");
    Stack::new()
        .gap(Space::Sm)
        .children(SPACES.map(|(space, name)| {
            Box::new()
                .padding(space)
                .border(Border::Hairline)
                .radius(Radius::Control)
                .child(
                    Box::new()
                        .surface(Surface::Muted)
                        .radius(Radius::Control)
                        .padding_x(Space::Sm)
                        .child(Typo::caption(format!("padding=\"{name}\" · {content}"))),
                )
        }))
        .into_any_element()
}

fn surfaces(lang: Lang) -> AnyElement {
    let (surface_label, border_label) =
        (lang.pick("surface", "표면"), lang.pick("border", "테두리"));
    let mut grid = Grid::new("box-surfaces")
        .columns(Columns::AUTO_FILL)
        .gap(Space::Sm);
    for (surface, surface_name) in SURFACES {
        for (border, border_name) in BORDERS {
            grid = grid.child(
                Box::new()
                    .surface(surface)
                    .border(border)
                    .radius(Radius::Panel)
                    .padding(Space::Md)
                    .child(
                        Typo::caption(format!("{surface_label}={surface_name}"))
                            .tone(Tone::Secondary),
                    )
                    .child(
                        Typo::caption(format!("{border_label}={border_name}"))
                            .tone(Tone::Secondary),
                    ),
            );
        }
    }
    grid.into_any_element()
}

fn radius(lang: Lang) -> AnyElement {
    let content = lang.pick("Content", "내용");
    Stack::row()
        .gap(Space::Sm)
        .wrap(true)
        .children(RADII.map(|(radius, name)| {
            Box::new()
                .radius(radius)
                .border(Border::Hairline)
                .surface(Surface::Raised)
                .padding_x(Space::Md)
                .padding_y(Space::Xs)
                .child(Typo::caption(format!("{name} · {content}")))
        }))
        .into_any_element()
}

fn indented() -> AnyElement {
    Box::new()
        .padding_start(Space::Xxl)
        .border(Border::Hairline)
        .radius(Radius::Control)
        .padding_y(Space::Sm)
        .child(Typo::body(
            "paddingStart indents one side only; the row keeps its full width.",
        ))
        .into_any_element()
}
