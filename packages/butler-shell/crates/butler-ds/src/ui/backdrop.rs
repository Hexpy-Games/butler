//! A `backdrop-filter` token (`saturate(..) blur(..)`) painted through gpui's backdrop lens,
//! which carries the saturation after the blur, as CSS applies the list's filters in order.
use gpui::{BackdropLens, Corners, Pixels, Window};

use super::context::Ds;
use super::convert;
use crate::tokens::{Filter, FilterOp};

#[derive(Clone, Copy, Debug)]
pub struct Backdrop {
    blur: Pixels,
    lens: BackdropLens,
}

impl Backdrop {
    /// The blur radius and saturation of the theme's value of `token`.
    pub fn new(ds: &Ds, token: Filter) -> Self {
        let mut backdrop = Self {
            blur: Pixels::ZERO,
            lens: BackdropLens::default(),
        };
        for op in ds.tokens().filter(token) {
            match *op {
                FilterOp::Blur(len) => backdrop.blur = convert::pixels(len, ds.tokens()),
                FilterOp::Saturate(amount) => backdrop.lens.saturation = Some(amount),
                FilterOp::Brightness(_) | FilterOp::Contrast(_) | FilterOp::Opacity(_) => {}
            }
        }
        backdrop
    }

    /// Paints the filtered backdrop of `bounds`, clipped to the rounded corners.
    pub fn paint(&self, bounds: gpui::Bounds<Pixels>, radii: Corners<Pixels>, window: &mut Window) {
        window.paint_backdrop_lens(
            bounds,
            radii,
            0.,
            &[gpui::Filter::Blur(self.blur)],
            self.lens,
        );
    }
}
