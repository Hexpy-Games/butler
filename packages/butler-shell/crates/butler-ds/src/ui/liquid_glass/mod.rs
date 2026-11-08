//! Liquid Glass through the Butler gpui-ce lens (tag butler-lens-1): every glass surface of the
//! DS uses the native-matched material ([`material`]) at the owner's hairline strength. This
//! replaces the tinted-glass look (a saturated blur under an opaque tint).
//!
//! Children painted after a glass layer stay sharp above it.
mod material;
pub mod presence;

use gpui::{Bounds, Corners, Pixels, Window, px};

pub use material::Place;
use material::Settings;
pub use presence::{presence, with_presence, without_presence};

use crate::ui::context::Ds;

/// How a native glass element sits and responds.
#[derive(Clone, Copy, Debug)]
pub struct LiquidGlass {
    pub place: Place,
    /// Added to the fill's brightness (hover, press).
    pub lift: f32,
    /// Growth per side while pressed (pt), about the centre.
    pub grow: f32,
    /// 0..=1: how far the glass has materialized (LG research §5 Appear/disappear): the lens
    /// ramps from identity instead of the glass fading. 1 is the full material.
    pub materialize: f32,
    reduce_transparency: bool,
    increase_contrast: bool,
    reduce_motion: bool,
}

impl LiquidGlass {
    pub fn over_content() -> Self {
        Self {
            place: Place::Content,
            lift: 0.,
            grow: 0.,
            materialize: 1.,
            reduce_transparency: false,
            increase_contrast: false,
            reduce_motion: false,
        }
    }

    pub fn on_glass(lift: f32, grow: f32) -> Self {
        Self {
            place: Place::OnGlass,
            lift,
            grow,
            materialize: 1.,
            reduce_transparency: false,
            increase_contrast: false,
            reduce_motion: false,
        }
    }

    /// How far the glass has materialized (an overlay's presence progress).
    pub fn materialize(mut self, progress: f32) -> Self {
        self.materialize = progress;
        self
    }

    /// Follow the OS Reduce Transparency, Increase Contrast and Reduce Motion settings
    /// (LG research §6, §8.1.8). Under Reduce Motion the glass materializes instantly.
    pub fn adapt(mut self, ds: &Ds) -> Self {
        self.reduce_transparency = ds.reduced_transparency();
        self.increase_contrast = ds.increased_contrast();
        self.reduce_motion = ds.reduced_motion();
        self
    }
}

/// The glass of `bounds` with `radii`, over what was painted before it.
pub fn paint(
    bounds: Bounds<Pixels>,
    radii: Corners<Pixels>,
    dark: bool,
    glass: LiquidGlass,
    window: &mut Window,
) {
    let (w, h) = (bounds.size.width.as_f32(), bounds.size.height.as_f32());
    if w < 1. || h < 1. {
        return;
    }
    let radii = radii.map(|r| px(r.as_f32().min(w / 2.).min(h / 2.)));
    let r = radii.max().as_f32();
    let circle = (w - h).abs() < 0.5 && r >= w / 2. - 0.5;
    let settings = Settings {
        // Reduce Motion: instant, no animated lensing (LG research §6, §8.1.8).
        materialize: if glass.reduce_motion {
            1.
        } else {
            glass.materialize
        },
        reduce_transparency: glass.reduce_transparency,
        increase_contrast: glass.increase_contrast,
    };
    let m = material::material(dark, (w, h), circle, glass.place, settings);
    material::paint(bounds, radii, &m, glass.lift, glass.grow, window);
}
