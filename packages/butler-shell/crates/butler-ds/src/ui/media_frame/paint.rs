//! The picture layer of a MediaFrame, painted into its box.
use std::sync::Arc;

use gpui::{Bounds, BoxShadow, Corners, Hsla, Pixels, RenderImage, Window, point, px, size};

/// How the picture meets the frame.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    /// Contained in the whole frame, letterboxed on the matte.
    Fill,
    /// Whole, inset on the matte, with a hairline and a card shadow.
    Matte,
    /// Fills the frame, cropped from the centre.
    Cover,
}

pub(super) struct Picture {
    pub(super) data: Arc<RenderImage>,
    pub(super) mode: Mode,
    /// The frame's corner radius (`--radius-control`).
    pub(super) radius: Pixels,
    /// Ring and shadow layers of a matted picture.
    pub(super) matte_shadows: Vec<BoxShadow>,
}

/// `object-fit` of a `pw` x `ph` picture in `area`: the contained or the covering box.
fn fitted(area: Bounds<Pixels>, pw: f32, ph: f32, cover: bool) -> Bounds<Pixels> {
    let (bw, bh) = (f32::from(area.size.width), f32::from(area.size.height));
    let scale = if cover {
        (bw / pw).max(bh / ph)
    } else {
        (bw / pw).min(bh / ph)
    };
    let (w, h) = (pw * scale, ph * scale);
    Bounds::new(
        point(
            area.origin.x + px((bw - w) / 2.),
            area.origin.y + px((bh - h) / 2.),
        ),
        size(px(w), px(h)),
    )
}

/// The radius of each corner of `rect` that sits on a corner of `frame` (a picture that spans
/// the frame follows its rounded corners; one that does not has square ones).
fn follow_corners(rect: Bounds<Pixels>, frame: Bounds<Pixels>, radius: Pixels) -> Corners<Pixels> {
    let near = |a: Pixels, b: Pixels| (f32::from(a) - f32::from(b)).abs() < 0.5;
    let (left, top) = (
        near(rect.origin.x, frame.origin.x),
        near(rect.origin.y, frame.origin.y),
    );
    let (right, bottom) = (
        near(rect.right(), frame.right()),
        near(rect.bottom(), frame.bottom()),
    );
    let pick = |on: bool| if on { radius } else { px(0.) };
    Corners {
        top_left: pick(left && top),
        top_right: pick(right && top),
        bottom_right: pick(right && bottom),
        bottom_left: pick(left && bottom),
    }
}

impl Picture {
    /// Paints into `area`; `frame` is the frame's whole box.
    pub(super) fn paint(&self, area: Bounds<Pixels>, frame: Bounds<Pixels>, window: &mut Window) {
        let pixels = self.data.size(0);
        let (pw, ph) = (pixels.width.0 as f32, pixels.height.0 as f32);
        if pw <= 0. || ph <= 0. {
            return;
        }
        let rect = fitted(area, pw, ph, self.mode == Mode::Cover);
        let (clip, corners) = match self.mode {
            Mode::Cover => (area, follow_corners(area, frame, self.radius)),
            Mode::Fill => (rect, follow_corners(rect, frame, self.radius)),
            Mode::Matte => (rect, Corners::all(self.radius / 2.)),
        };
        if self.mode == Mode::Matte {
            window.paint_drop_shadows_outside(rect, corners, 0., &self.matte_shadows);
        }
        window
            .paint_image(clip, rect, corners, 0., self.data.clone(), 0, false)
            .ok();
    }
}

/// `radial-gradient(circle at 50% 45%, tint, transparent 72%)` as stacked discs: each adds a
/// share of the tint, so the sum falls off linearly from the centre to the 72% radius.
pub(super) fn paint_glow(frame: Bounds<Pixels>, tint: Hsla, window: &mut Window) {
    const STEPS: usize = 36;
    let centre = point(
        frame.origin.x + frame.size.width * 0.5,
        frame.origin.y + frame.size.height * 0.45, // DS: MediaFrame.module.css:107
    );
    let (w, h) = (f32::from(frame.size.width), f32::from(frame.size.height));
    let far = ((w * 0.5).max(w * 0.5)).hypot((h * 0.45).max(h * 0.55)); // farthest corner
    let reach = far * 0.72; // DS: MediaFrame.module.css:109
    // `n` discs each at alpha `a` composite to 1 - (1 - a)^n; pick `a` so the centre reaches the tint.
    let each = 1. - (1. - tint.alpha).powf(1. / STEPS as f32);
    for step in 0..STEPS {
        let radius = reach * (1. - step as f32 / STEPS as f32);
        let disc = Bounds::new(
            point(centre.x - px(radius), centre.y - px(radius)),
            size(px(radius * 2.), px(radius * 2.)),
        );
        window.paint_quad(
            gpui::PaintQuad::new(disc)
                .background(Hsla {
                    alpha: each,
                    ..tint
                })
                .corner_radii(Corners::all(px(radius))),
        );
    }
}
