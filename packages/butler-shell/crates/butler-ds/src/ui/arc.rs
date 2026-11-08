//! A round-capped circular stroke, painted as a path: the shape of the Spinner's orbit and the
//! ProgressRing's track and fill (an SVG `circle` with `stroke-linecap: round`).
use gpui::{Hsla, PathBuilder, Pixels, Point, Window, point, px};

/// Angle of twelve o'clock, where both rings start.
pub const TOP: f32 = -std::f32::consts::FRAC_PI_2;

fn polygon(window: &mut Window, points: impl Iterator<Item = Point<Pixels>>, color: Hsla) {
    let mut path = PathBuilder::fill();
    for (i, p) in points.enumerate() {
        if i == 0 {
            path.move_to(p);
        } else {
            path.line_to(p);
        }
    }
    path.close();
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

fn disc(window: &mut Window, center: Point<Pixels>, radius: f32, color: Hsla) {
    let steps = 24;
    polygon(
        window,
        (0..steps).map(|i| {
            let a = i as f32 / steps as f32 * std::f32::consts::TAU;
            point(
                center.x + px(radius * a.cos()),
                center.y + px(radius * a.sin()),
            )
        }),
        color,
    );
}

/// A full ring of `width` around `center`.
pub fn ring(
    window: &mut impl super::thinking_mark::Painter,
    center: Point<Pixels>,
    radius: f32,
    width: f32,
    color: Hsla,
) {
    let steps = 96;
    let mut path = PathBuilder::stroke(px(width));
    for i in 0..=steps {
        let a = i as f32 / steps as f32 * std::f32::consts::TAU;
        let p = point(
            center.x + px(radius * a.cos()),
            center.y + px(radius * a.sin()),
        );
        if i == 0 {
            path.move_to(p);
        } else {
            path.line_to(p);
        }
    }
    path.close();
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

/// An arc from `start` (radians, clockwise from three o'clock) sweeping `sweep` radians, with
/// round caps.
pub fn stroke(
    window: &mut Window,
    center: Point<Pixels>,
    radius: f32,
    width: f32,
    (start, sweep): (f32, f32),
    color: Hsla,
) {
    let at = |angle: f32| {
        point(
            center.x + px(radius * angle.cos()),
            center.y + px(radius * angle.sin()),
        )
    };
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a small non-negative segment count"
    )]
    let steps = ((sweep.abs() / std::f32::consts::TAU * 96.).ceil() as usize).max(1);
    if sweep.abs() > 1e-4 {
        let mut path = PathBuilder::stroke(px(width));
        for i in 0..=steps {
            let p = at(start + sweep * i as f32 / steps as f32);
            if i == 0 {
                path.move_to(p);
            } else {
                path.line_to(p);
            }
        }
        if let Ok(path) = path.build() {
            window.paint_path(path, color);
        }
    }
    disc(window, at(start), width / 2., color);
    disc(window, at(start + sweep), width / 2., color);
}
