//! PickOutline.showcase.tsx (+ PickOutline.demo.tsx): hover and two picks, the marks on white,
//! black and photo pages, at the page edge, the picking state with nothing picked and reduced
//! motion. The page is a plain stand-in (blocks at the shop cards' rects, a gradient with discs
//! for the photo); the React story draws an SVG shop page.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::blocks::pick_outline::{PickOutline, PickOutlinePick, PickRect};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Columns, Grid, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, Div, IntoElement as _, ParentElement as _, Styled as _, Window, div, px,
    relative, rgb,
};

use super::Story;
use crate::browser_demo::sub;
use crate::copy::Lang;

/// The page the marks are drawn over.
#[derive(Clone, Copy, PartialEq)]
enum Page {
    Shop,
    White,
    Black,
    Photo,
}

/// What is under the pointer: a product card (0-7) or the page's top bar.
#[derive(Clone, Copy)]
enum Hover {
    Card(usize),
    Header,
}

/// `PickStageProps`.
#[derive(Clone, Copy)]
struct Stage {
    id: &'static str,
    page: Page,
    picked: &'static [usize],
    hover: Hover,
    reduced: bool,
    caption: Option<&'static str>,
}

const BASE: Stage = Stage {
    id: "po",
    page: Page::Shop,
    picked: &[0, 1],
    hover: Hover::Card(2),
    reduced: false,
    caption: None,
};

/// The page's header bar (1280x72): the top-edge case, where the hover tag has no room above.
const HEADER: PickRect = PickRect {
    x: 0.,
    y: 0.,
    width: 1280.,
    height: 72.,
};

/// `shopCardRect`: product card `index` (0-7) of the shop page, in page pixels (1280x800).
fn card_rect(index: usize) -> PickRect {
    // The index is 0-7, so the casts are exact.
    #[expect(clippy::cast_precision_loss, reason = "a card index of 0 to 7")]
    let (column, row) = ((index % 4) as f32, (index / 4) as f32);
    PickRect::new(312. + column * 232., 168. + row * 300., 216., 284.) // DS: pages.ts:19
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            // The proposal's pick mode: two picks with their order, the next card under the pointer.
            name: "Hover and two picks",
            render: |_, w, c| {
                stage(
                    Stage {
                        id: "po-two",
                        ..BASE
                    },
                    w,
                    c,
                )
            },
        },
        Story {
            // Acceptance: the outline reads on white, black and photo pages.
            name: "Readable on white, black and photo pages",
            render: readable,
        },
        Story {
            // A hover at the page's top edge keeps its tag inside the outline; a pick at the edge
            // keeps its badge.
            name: "At the page edge",
            render: |_, w, c| {
                let edge = Stage {
                    id: "po-edge",
                    picked: &[4, 0],
                    hover: Hover::Header,
                    ..BASE
                };
                stage(edge, w, c)
            },
        },
        Story {
            name: "Picking, nothing picked yet",
            render: |_, w, c| {
                let none = Stage {
                    id: "po-none",
                    picked: &[],
                    hover: Hover::Card(5),
                    ..BASE
                };
                stage(none, w, c)
            },
        },
        Story {
            name: "Reduced motion: no fade or pop",
            render: |_, w, c| {
                let still = Stage {
                    id: "po-reduced",
                    picked: &[0, 1, 2],
                    hover: Hover::Card(3),
                    reduced: true,
                    caption: Some("reduced"),
                    ..BASE
                };
                stage(still, w, c)
            },
        },
    ]
}

fn readable(_: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let cell = |id, page, caption| Stage {
        id,
        page,
        picked: &[0],
        hover: Hover::Card(1),
        caption: Some(caption),
        ..BASE
    };
    let cells = [
        cell("po-white", Page::White, "white"),
        cell("po-black", Page::Black, "black"),
        cell("po-photo", Page::Photo, "photo"),
    ]
    .map(|spec| stage(spec, window, cx));
    Grid::new("po-readable")
        .columns(Columns::fixed(3))
        .gap(Space::Md)
        .children(cells)
        .into_any_element()
}

/// A box at a page rect, as fractions of the 1280x800 page.
fn block(rect: PickRect) -> Div {
    div()
        .absolute()
        .left(relative(rect.x / 1280.))
        .top(relative(rect.y / 800.))
        .w(relative(rect.width / 1280.))
        .h(relative(rect.height / 800.))
}

/// The page stand-in: the shop's header and product cards, a plain colour, or a photo-like
/// gradient with discs.
fn page_surface(page: Page) -> Div {
    let fill = |hex| div().absolute().size_full().bg(rgb(hex));
    match page {
        Page::White => fill(0x00ff_ffff),
        Page::Black => fill(0x0000_0000),
        Page::Photo => {
            let disc = |hex, cx: f32, cy: f32, r: f32| {
                block(PickRect::new(cx - r, cy - r, 2. * r, 2. * r))
                    .rounded_full()
                    .bg(rgb(hex))
                    .opacity(0.9)
            };
            div()
                .absolute()
                .size_full()
                .bg(gpui::linear_gradient(
                    135.,
                    gpui::linear_color_stop(rgb(0x0087_a8c4), 0.),
                    gpui::linear_color_stop(rgb(0x003b_4d3a), 1.),
                ))
                .child(disc(0x002d_6a4f, 240., 240., 180.))
                .child(disc(0x00f4_a261, 840., 180., 150.))
                .child(disc(0x0026_4653, 1040., 640., 200.))
                .child(disc(0x00e9_c46a, 440., 660., 160.))
                .child(disc(0x008e_cae6, 660., 400., 120.))
        }
        Page::Shop => {
            let header = block(HEADER)
                .bg(rgb(0x00ff_ffff))
                .border_b_1()
                .border_color(rgb(0x00ec_eef1));
            (0..8).fold(fill(0x00ff_ffff).child(header), |page, index| {
                let rect = card_rect(index);
                let picture = PickRect::new(rect.x, rect.y, 216., 180.);
                let line = |dy: f32, width: f32| {
                    block(PickRect::new(rect.x + 14., rect.y + dy, width, 12.))
                        .rounded_full()
                        .bg(rgb(0x00d7_dbe0))
                };
                page.child(
                    block(rect)
                        .rounded(px(10.))
                        .bg(rgb(0x00ff_ffff))
                        .border_1()
                        .border_color(rgb(0x00ec_eef1)),
                )
                .child(block(picture).rounded(px(10.)).bg(rgb(0x00ec_e8e1)))
                .child(line(204., 150.))
                .child(line(230., 90.))
            })
        }
    }
}

/// `PickStage`: a page at 16:10 with the user's pick marks; rects are page pixels times the
/// scale.
fn stage(spec: Stage, window: &mut Window, cx: &mut App) -> AnyElement {
    let (seen, recorder) = butler_ds::ui::blocks::measure::track(sub(spec.id, "stage"), window, cx);
    let ds = Ds::get(cx);
    let width = f32::from(seen.width);
    let scale = width / 1280.;
    let hover = match spec.hover {
        Hover::Header => HEADER,
        Hover::Card(index) => card_rect(index),
    };
    let name = match spec.hover {
        Hover::Header => "header",
        Hover::Card(_) => "div.card",
    };
    let label = format!("{name} · {} × {}", hover.width, hover.height);
    let marks = (width > 0.).then(|| {
        let mut outline = PickOutline::new(sub(spec.id, "marks"), width, (800. * scale).round())
            .scale(scale)
            .hover(hover)
            .hover_label(label)
            .picks(
                spec.picked
                    .iter()
                    .map(|&index| PickOutlinePick::new(format!("card-{index}"), card_rect(index))),
            );
        if spec.reduced {
            outline = outline.reduced_motion();
        }
        outline
    });
    let frame = div()
        .relative()
        .overflow_hidden()
        .w_full()
        .aspect_ratio(16. / 10.)
        .rounded(ds.len(Length::RadiusControl))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .child(recorder)
        .child(page_surface(spec.page))
        .children(marks);
    Stack::new()
        .gap(Space::Xs)
        .child(frame)
        .children(
            spec.caption
                .map(|text| Typo::caption(text).tone(Tone::Tertiary)),
        )
        .into_any_element()
}
