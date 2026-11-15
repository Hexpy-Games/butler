//! The two painters the browser blocks share: the riso edge (a conic gradient border: gpui has
//! no conic paint, so the ring is cut into small cells, each in the colour of its angle) and the
//! corner caps that stand in for a rounded clip (gpui clips children to a rectangle).
use gpui::{
    Bounds, Corners, Edges, Hsla, IntoElement, PaintQuad, PathBuilder, Pixels, Window, canvas,
    point, px, size,
};

use crate::tokens::Color;
use crate::ui::context::Ds;
use crate::ui::convert::mix;

/// The turn of the edge at rest (`--page-card-edge-angle` initial value).
const REST_ANGLE: f32 = 135.; // DS: PageCard.module.css:18
/// The longest straight piece of the ring painted in one colour.
const CELL: f32 = 6.;
/// How deep a straight cell's quad is (its border is the visible ring).
const REACH: f32 = 4.;
/// The side of a tile of the conic fill: it shows through at a few percent, so it is coarse.
const TILE: f32 = 20.;
/// The side of a tile that touches a rounded corner.
const CORNER_TILE: f32 = 2.;

/// The riso inks, blue first.
pub(in crate::ui::blocks) fn inks(ds: &Ds) -> [Hsla; 3] {
    [
        ds.color(Color::ButlerInkBlue),
        ds.color(Color::ButlerInkPurple),
        ds.color(Color::ButlerInkPink),
    ]
}

/// The angle of the edge. It rests at 135deg, as under reduced motion.
// ANIM-MIGRATE(the edge turns one full turn per --motion-agent-edge, on --motion-loop-count while
// Butler holds the tab: gpui has no conic paint whose angle a layer motion can drive)
fn angle_now() -> f32 {
    REST_ANGLE
}

/// A count of cells: a non-negative length rounded up.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "cell counts are small and non-negative"
)]
fn count(value: f32) -> usize {
    value.max(0.) as usize
}

fn conic(inks: &[Hsla; 3], from: f32, (cx, cy): (f32, f32), (x, y): (f32, f32)) -> Hsla {
    let degrees = (x - cx).atan2(cy - y).to_degrees();
    let turn = (degrees - from).rem_euclid(360.) / 360. * 3.;
    let index = count(turn.floor()).min(2);
    mix(inks[(index + 1) % 3], inks[index], turn - index as f32)
}

/// What the ring is: its outer box (given at paint), corner radii and the width of its edges
/// (zero omits an edge; every present edge has the same width).
#[derive(Clone, Copy)]
pub(in crate::ui::blocks) struct Ring {
    pub radii: Corners<Pixels>,
    pub widths: Edges<Pixels>,
    pub inks: [Hsla; 3],
}

/// A ring element filling the box it is placed in (an absolute child).
pub(in crate::ui::blocks) fn riso_ring(ring: Ring) -> impl IntoElement {
    use gpui::Styled as _;
    canvas(
        |bounds, _, _| bounds,
        move |_, bounds, window, _| {
            let angle = angle_now();
            paint_ring(&ring, angle, bounds, window);
        },
    )
    .absolute()
    .size_full()
}

/// The riso edge's conic gradient under a translucent surface: `background: linear-gradient(bg)
/// padding-box, conic-gradient(...) border-box` lets the conic show through a surface that is
/// not opaque (`--workspace-bg` is 94%). Tiles of the conic, then the surface over them; the tiles
/// of the rounded corners are left out, so the surface's own corners stay the shape.
pub(in crate::ui::blocks) fn riso_fill(ring: Ring, surface: Hsla) -> impl IntoElement {
    use gpui::Styled as _;
    canvas(
        |bounds, _, _| bounds,
        move |_, bounds, window, _| {
            let angle = angle_now();
            paint_fill(&ring, surface, angle, bounds, window);
        },
    )
    .absolute()
    .size_full()
}

fn paint_fill(ring: &Ring, surface: Hsla, angle: f32, bounds: Bounds<Pixels>, window: &mut Window) {
    let f = |p: Pixels| f32::from(p);
    let (x0, y0) = (f(bounds.origin.x), f(bounds.origin.y));
    let (w, h) = (f(bounds.size.width), f(bounds.size.height));
    let center = (x0 + w / 2., y0 + h / 2.);
    let corners = [
        (f(ring.radii.top_left), (x0, y0), (1., 1.)),
        (f(ring.radii.top_right), (x0 + w, y0), (-1., 1.)),
        (f(ring.radii.bottom_right), (x0 + w, y0 + h), (-1., -1.)),
        (f(ring.radii.bottom_left), (x0, y0 + h), (1., -1.)),
    ];
    // A point of a corner's square outside its circle is not part of the surface.
    let outside = |x: f32, y: f32| {
        corners.iter().any(|&(r, (cx, cy), (sx, sy))| {
            let (ox, oy) = ((x - cx) * sx, (y - cy) * sy);
            r > 0. && ox < r && oy < r && (ox - r).hypot(oy - r) > r
        })
    };
    let (cols, rows) = (count((w / TILE).ceil()), count((h / TILE).ceil()));
    for row in 0..rows {
        for col in 0..cols {
            let (tx, ty) = (x0 + col as f32 * TILE, y0 + row as f32 * TILE);
            let (tw, th) = (TILE.min(x0 + w - tx), TILE.min(y0 + h - ty));
            // A tile that touches a corner is cut into small ones, those outside the circle left out.
            let near = [(tx, ty), (tx + tw, ty), (tx, ty + th), (tx + tw, ty + th)]
                .iter()
                .any(|&(x, y)| outside(x, y));
            let step = if near { CORNER_TILE } else { TILE };
            let (nx, ny) = (count((tw / step).ceil()), count((th / step).ceil()));
            for j in 0..ny {
                for i in 0..nx {
                    let (sx, sy) = (tx + i as f32 * step, ty + j as f32 * step);
                    let (sw, sh) = (step.min(tx + tw - sx), step.min(ty + th - sy));
                    let middle = (sx + sw / 2., sy + sh / 2.);
                    if near && outside(middle.0, middle.1) {
                        continue;
                    }
                    let c = conic(&ring.inks, angle, center, middle);
                    let tile = Bounds::new(point(px(sx), px(sy)), size(px(sw), px(sh)));
                    window.paint_quad(PaintQuad::new(tile).background(c));
                }
            }
        }
    }
    window.paint_quad(
        PaintQuad::new(bounds)
            .corner_radii(ring.radii)
            .background(surface),
    );
}

fn paint_cells(window: &mut Window, cut: Bounds<Pixels>, paint: impl FnOnce(&mut Window)) {
    let mask = gpui::ContentMask {
        bounds: cut,
        ..gpui::ContentMask::default()
    };
    window.with_content_mask(Some(mask), paint);
}

#[derive(Clone, Copy)]
enum Side {
    Top,
    Bottom,
    Left,
    Right,
}

fn paint_ring(ring: &Ring, angle: f32, bounds: Bounds<Pixels>, window: &mut Window) {
    let f = |p: Pixels| f32::from(p);
    let (x0, y0) = (f(bounds.origin.x), f(bounds.origin.y));
    let (x1, y1) = (x0 + f(bounds.size.width), y0 + f(bounds.size.height));
    let center = (f32::midpoint(x0, x1), f32::midpoint(y0, y1));
    let color = |x: f32, y: f32| conic(&ring.inks, angle, center, (x, y));
    let (tl, tr, br, bl) = (
        f(ring.radii.top_left),
        f(ring.radii.top_right),
        f(ring.radii.bottom_right),
        f(ring.radii.bottom_left),
    );
    let w = ring.widths;
    // A straight edge is a run of cells, each a quad whose border on that side is the ring: gpui
    // snaps a border to at least one device pixel, where a filled strip could round to none.
    let strip = |window: &mut Window, side: Side, (ax, ay, bx, by): (f32, f32, f32, f32)| {
        let horizontal = matches!(side, Side::Top | Side::Bottom);
        let length = if horizontal { bx - ax } else { by - ay };
        let cells = count((length / CELL).ceil());
        for i in 0..cells {
            let from = i as f32 * length / cells as f32;
            let to = (i + 1) as f32 * length / cells as f32;
            let c = color(
                if horizontal {
                    ax + f32::midpoint(from, to)
                } else {
                    ax + (bx - ax) / 2.
                },
                if horizontal {
                    ay + (by - ay) / 2.
                } else {
                    ay + f32::midpoint(from, to)
                },
            );
            // The quad is `REACH` deep so snapping cannot collapse it; only the border shows.
            let (rx, ry, rw, rh) = match side {
                Side::Top => (ax + from, ay, to - from, REACH),
                Side::Bottom => (ax + from, by - REACH, to - from, REACH),
                Side::Left => (ax, ay + from, REACH, to - from),
                Side::Right => (bx - REACH, ay + from, REACH, to - from),
            };
            let thickness = if horizontal { by - ay } else { bx - ax };
            let mut widths = Edges::all(px(0.));
            match side {
                Side::Top => widths.top = px(thickness),
                Side::Bottom => widths.bottom = px(thickness),
                Side::Left => widths.left = px(thickness),
                Side::Right => widths.right = px(thickness),
            }
            let quad = PaintQuad::new(Bounds::new(point(px(rx), px(ry)), size(px(rw), px(rh))))
                .border_widths(widths)
                .border_color(c);
            window.paint_quad(quad);
        }
    };
    let (wt, wl, wr, wb) = (f(w.top), f(w.left), f(w.right), f(w.bottom));
    if wt > 0. {
        let a = if wl > 0. { tl } else { 0. };
        let b = if wr > 0. { tr } else { 0. };
        strip(window, Side::Top, (x0 + a, y0, x1 - b, y0 + wt));
    }
    if wb > 0. {
        let a = if wl > 0. { bl } else { 0. };
        let b = if wr > 0. { br } else { 0. };
        strip(window, Side::Bottom, (x0 + a, y1 - wb, x1 - b, y1));
    }
    if wl > 0. {
        let a = if wt > 0. { tl } else { 0. };
        let b = if wb > 0. { bl } else { 0. };
        strip(window, Side::Left, (x0, y0 + a, x0 + wl, y1 - b));
    }
    if wr > 0. {
        let a = if wt > 0. { tr } else { 0. };
        let b = if wb > 0. { br } else { 0. };
        strip(window, Side::Right, (x1 - wr, y0 + a, x1, y1 - b));
    }
    paint_arcs(window, ring, (x0, y0, x1, y1), &color);
}

/// The four corner arcs of a ring whose outer box is `(x0, y0, x1, y1)`.
fn paint_arcs(
    window: &mut Window,
    ring: &Ring,
    (x0, y0, x1, y1): (f32, f32, f32, f32),
    color: &impl Fn(f32, f32) -> Hsla,
) {
    let value = |length: Pixels| f32::from(length);
    let w = ring.widths;
    let (wt, wl, wr, wb) = (value(w.top), value(w.left), value(w.right), value(w.bottom));
    let r = ring.radii;
    let arcs = [
        (value(r.top_left), wt.min(wl), (x0, y0), (1., 1.)),
        (value(r.top_right), wt.min(wr), (x1, y0), (-1., 1.)),
        (value(r.bottom_right), wb.min(wr), (x1, y1), (-1., -1.)),
        (value(r.bottom_left), wb.min(wl), (x0, y1), (1., -1.)),
    ];
    for (radius, width, corner, direction) in arcs {
        if radius > 0. && width > 0. {
            paint_arc(window, radius, width, corner, direction, color);
        }
    }
}

/// One corner's arc: a circle ring of the corner's radius, painted in cells of its quadrant.
fn paint_arc(
    window: &mut Window,
    radius: f32,
    width: f32,
    (cx, cy): (f32, f32),
    (sx, sy): (f32, f32),
    color: &impl Fn(f32, f32) -> Hsla,
) {
    // The quadrant square spans from the corner point `(cx, cy)` by `radius` toward the box.
    let (qx, qy) = (cx.min(cx + sx * radius), cy.min(cy + sy * radius));
    let circle = Bounds::new(
        point(
            px(cx + if sx > 0. { 0. } else { -2. * radius }),
            px(cy + if sy > 0. { 0. } else { -2. * radius }),
        ),
        size(px(2. * radius), px(2. * radius)),
    );
    let cells = count((radius / CELL).ceil()).max(1);
    let step = radius / cells as f32;
    for row in 0..cells {
        for col in 0..cells {
            let (rx, ry) = (qx + col as f32 * step, qy + row as f32 * step);
            let cut = Bounds::new(point(px(rx), px(ry)), size(px(step), px(step)));
            let c = color(rx + step / 2., ry + step / 2.);
            let quad = PaintQuad::new(circle)
                .corner_radii(Corners::all(px(radius)))
                .border_widths(Edges::all(px(width)))
                .border_color(c);
            paint_cells(window, cut, |window| window.paint_quad(quad));
        }
    }
}

/// Paints what lies outside a rounded corner of `bounds` in `color`, so a child that paints into
/// the square corner reads as clipped by the radius. `radii` is top-left, top-right,
/// bottom-right, bottom-left.
pub(in crate::ui::blocks) fn corner_caps(
    window: &mut Window,
    bounds: Bounds<Pixels>,
    radii: [Pixels; 4],
    color: Hsla,
) {
    let value = |length: Pixels| f32::from(length);
    let (x0, y0) = (value(bounds.origin.x), value(bounds.origin.y));
    let (x1, y1) = (
        x0 + value(bounds.size.width),
        y0 + value(bounds.size.height),
    );
    let corners = [
        ((x0, y0), (1., 1.)),
        ((x1, y0), (-1., 1.)),
        ((x1, y1), (-1., -1.)),
        ((x0, y1), (1., -1.)),
    ];
    for (radius, ((cx, cy), (sx, sy))) in radii.into_iter().zip(corners) {
        let reach = value(radius);
        if reach <= 0. {
            continue;
        }
        let mut path = PathBuilder::fill();
        path.move_to(point(px(cx), px(cy)));
        path.line_to(point(px(cx + sx * reach), px(cy)));
        let steps = 16_u8;
        for step in 0..=steps {
            let turn = f32::from(step) / f32::from(steps) * std::f32::consts::FRAC_PI_2;
            // From the point on the horizontal edge round to the point on the vertical edge.
            let (x, y) = (
                cx + sx * reach * (1. - turn.sin()),
                cy + sy * reach * (1. - turn.cos()),
            );
            path.line_to(point(px(x), px(y)));
        }
        path.line_to(point(px(cx), px(cy + sy * reach)));
        path.close();
        if let Ok(path) = path.build() {
            window.paint_path(path, color);
        }
    }
}
