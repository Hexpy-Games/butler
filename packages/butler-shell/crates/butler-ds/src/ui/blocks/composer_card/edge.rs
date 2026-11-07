//! ComposerEdgeCharacter (ComposerEdgeCharacter.tsx / ComposerDecoration.module.css): a small
//! crab or cat peeking over the card's top edge. Decorative. The SVG shapes are drawn as paths in
//! the same 44-unit-wide boxes.
use gpui::{
    App, Hsla, IntoElement, ParentElement as _, PathBuilder, Pixels, Point, RenderOnce,
    Styled as _, Window, canvas, div, point, px, relative,
};

use crate::tokens::Color;
use crate::ui::context::Ds;
use crate::ui::convert;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeKind {
    Crab,
    Cat,
}

/// `behind` is the head (the card hides its lower 8px); `front` the paws or claws on the edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgePart {
    Behind,
    Front,
}

/// The head's height and how much of it the card covers (px).
const HEAD: (f32, f32) = (34., 8.);
/// The width of both parts (`.head`, `.paws`).
const WIDTH: f32 = 44.;
/// The paws' height and their offset above the edge.
const PAWS: (f32, f32) = (10., 5.);

/// Px an edge character rises above the card's top edge (`COMPOSER_EDGE_CHARACTER_RISE`).
pub const RISE: f32 = HEAD.0 - HEAD.1;

enum Geo {
    Ellipse(f32, f32, f32, f32),
    Path(&'static str),
}

struct Part {
    geo: Geo,
    fill: Option<Color>,
    stroke: Option<(Color, f32)>,
    opacity: f32,
}

const fn part(geo: Geo, fill: Option<Color>, stroke: Option<(Color, f32)>) -> Part {
    Part {
        geo,
        fill,
        stroke,
        opacity: 1.,
    }
}

fn ellipse(
    c: (f32, f32),
    r: (f32, f32),
    fill: Option<Color>,
    stroke: Option<(Color, f32)>,
) -> Part {
    part(Geo::Ellipse(c.0, c.1, r.0, r.1), fill, stroke)
}

fn parts(kind: EdgeKind, edge: EdgePart) -> Vec<Part> {
    use Color::{
        Grayscale01, Grayscale06, Grayscale07, Grayscale11, NeutralWhite, Red03, Red05, Red08,
    };
    let fur = (Some(Grayscale01), Some((Grayscale07, 1.)));
    let red = (Some(Red05), Some((Red08, 1.)));
    match (kind, edge) {
        (EdgeKind::Crab, EdgePart::Behind) => vec![
            part(
                Geo::Path("M17 30 L15 12 M27 30 L29 12"),
                None,
                Some((Red08, 1.6)),
            ),
            ellipse(
                (15., 10.),
                (3.6, 3.6),
                Some(NeutralWhite),
                Some((Red08, 1.)),
            ),
            ellipse(
                (29., 10.),
                (3.6, 3.6),
                Some(NeutralWhite),
                Some((Red08, 1.)),
            ),
            ellipse((15.6, 10.4), (1.6, 1.6), Some(Grayscale11), None),
            ellipse((28.4, 10.4), (1.6, 1.6), Some(Grayscale11), None),
            ellipse((22., 30.), (16., 9.5), red.0, red.1),
            ellipse((17., 24.5), (1.4, 1.), Some(Red03), None),
            ellipse((27., 24.5), (1.4, 1.), Some(Red03), None),
        ],
        (EdgeKind::Crab, EdgePart::Front) => vec![
            part(
                Geo::Path("M5 8 C3 3 8 0.5 11 3 L9 5 L12 6 C11 8.5 7 9.5 5 8 Z"),
                red.0,
                red.1,
            ),
            part(
                Geo::Path("M39 8 C41 3 36 0.5 33 3 L35 5 L32 6 C33 8.5 37 9.5 39 8 Z"),
                red.0,
                red.1,
            ),
        ],
        (EdgeKind::Cat, EdgePart::Behind) => {
            let blush = |x: f32| Part {
                opacity: 0.8,
                ..ellipse((x, 23.), (2.6, 1.4), Some(Red03), None)
            };
            vec![
                part(
                    Geo::Path("M7 3 L4 17 L17 11 Z M37 3 L40 17 L27 11 Z"),
                    fur.0,
                    fur.1,
                ),
                part(
                    Geo::Path("M8 7 L6.5 14 L13 11 Z M36 7 L37.5 14 L31 11 Z"),
                    Some(Red03),
                    None,
                ),
                ellipse((22., 21.), (16., 12.5), fur.0, fur.1),
                blush(12.5),
                blush(31.5),
                ellipse((16.5, 18.5), (1.6, 2.1), Some(Grayscale11), None),
                ellipse((27.5, 18.5), (1.6, 2.1), Some(Grayscale11), None),
                part(Geo::Path("M20.6 22 h2.8 l-1.4 1.6 Z"), Some(Red03), None),
            ]
        }
        (EdgeKind::Cat, EdgePart::Front) => vec![
            ellipse((13., 5.), (4.6, 3.6), fur.0, fur.1),
            ellipse((31., 5.), (4.6, 3.6), fur.0, fur.1),
            part(
                Geo::Path("M11.5 6.5 v1.6 M14.5 6.5 v1.6 M29.5 6.5 v1.6 M32.5 6.5 v1.6"),
                None,
                Some((Grayscale06, 0.8)),
            ),
        ],
    }
}

/// The numbers and commands of an SVG path, for the subset the characters use (M L C h v Z).
fn trace(d: &str, at: Point<Pixels>, path: &mut PathBuilder) {
    let tokens: Vec<&str> = d.split_whitespace().collect();
    let num = |n: usize| tokens[n].parse::<f32>().unwrap_or(0.);
    let pt = |px_x: f32, px_y: f32| point(at.x + px(px_x), at.y + px(px_y));
    let (mut cur_x, mut cur_y, mut idx) = (0., 0., 0);
    while idx < tokens.len() {
        let command = tokens[idx];
        idx += 1;
        match command {
            "M" | "L" => {
                (cur_x, cur_y) = (num(idx), num(idx + 1));
                if command == "M" {
                    path.move_to(pt(cur_x, cur_y));
                } else {
                    path.line_to(pt(cur_x, cur_y));
                }
                idx += 2;
            }
            "C" => {
                let (c1, c2, to) = (
                    (num(idx), num(idx + 1)),
                    (num(idx + 2), num(idx + 3)),
                    (num(idx + 4), num(idx + 5)),
                );
                path.cubic_bezier_to(pt(to.0, to.1), pt(c1.0, c1.1), pt(c2.0, c2.1));
                (cur_x, cur_y) = to;
                idx += 6;
            }
            "h" | "v" | "l" => {
                let (dx, dy) = match command {
                    "h" => (num(idx), 0.),
                    "v" => (0., num(idx)),
                    _ => (num(idx), num(idx + 1)),
                };
                idx += if command == "l" { 2 } else { 1 };
                (cur_x, cur_y) = (cur_x + dx, cur_y + dy);
                path.line_to(pt(cur_x, cur_y));
            }
            _ => path.close(),
        }
    }
}

fn outline(geo: &Geo, at: Point<Pixels>, builder: &mut PathBuilder) {
    match geo {
        Geo::Path(d) => trace(d, at, builder),
        Geo::Ellipse(cx, cy, rx, ry) => {
            builder.move_to(point(at.x + px(cx - rx), at.y + px(*cy)));
            let radii = point(px(*rx), px(*ry));
            builder.arc_to(
                radii,
                px(0.),
                false,
                true,
                point(at.x + px(cx + rx), at.y + px(*cy)),
            );
            builder.arc_to(
                radii,
                px(0.),
                false,
                true,
                point(at.x + px(cx - rx), at.y + px(*cy)),
            );
            builder.close();
        }
    }
}

/// A part with its tokens resolved.
struct Painted {
    geo: Geo,
    fill: Option<Hsla>,
    stroke: Option<(Hsla, f32)>,
}

fn paint_part(part: &Painted, at: Point<Pixels>, window: &mut Window) {
    if let Some(fill) = part.fill {
        let mut builder = PathBuilder::fill();
        outline(&part.geo, at, &mut builder);
        if let Ok(path) = builder.build() {
            window.paint_path(path, fill);
        }
    }
    if let Some((color, width)) = part.stroke {
        let mut builder = PathBuilder::stroke(px(width));
        outline(&part.geo, at, &mut builder);
        if let Ok(path) = builder.build() {
            window.paint_path(path, color);
        }
    }
}

/// A character part for a card's `edge` slot. Place it in a zero-height strip on the card's top.
#[derive(IntoElement)]
pub struct EdgeCharacter {
    kind: EdgeKind,
    part: EdgePart,
}

impl EdgeCharacter {
    pub fn new(kind: EdgeKind, part: EdgePart) -> Self {
        Self { kind, part }
    }
}

impl RenderOnce for EdgeCharacter {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let shapes: Vec<Painted> = parts(self.kind, self.part)
            .into_iter()
            .map(|part| Painted {
                fill: part
                    .fill
                    .map(|token| convert::with_alpha(ds.color(token), part.opacity)),
                stroke: part.stroke.map(|(token, width)| {
                    (convert::with_alpha(ds.color(token), part.opacity), width)
                }),
                geo: part.geo,
            })
            .collect();
        let (height, bottom, top) = match self.part {
            EdgePart::Behind => (HEAD.0, Some(-HEAD.1), None),
            EdgePart::Front => (PAWS.0, None, Some(-PAWS.1)),
        };
        let drawing = canvas(
            |_, _, _| (),
            move |bounds, (), window, _| {
                for shape in &shapes {
                    paint_part(shape, bounds.origin, window);
                }
            },
        )
        .size_full();
        let el = div()
            .absolute()
            .right(relative(0.14))
            .w(px(WIDTH))
            .h(px(height))
            .child(drawing);
        match (bottom, top) {
            (Some(bottom), _) => el.bottom(px(bottom)),
            (_, Some(top)) => el.top(px(top)),
            _ => el,
        }
    }
}
