//! Liquid Glass through the Butler gpui-ce lens (tag butler-lens-1): every glass surface of the
//! DS uses the native-matched material ([`material`]) at the owner's hairline strength. This
//! replaces the tinted-glass look (a saturated blur under an opaque tint).
//!
//! Children painted after a glass layer stay sharp above it.
mod composer;
mod material;
pub mod presence;

use gpui::{Bounds, Corners, Pixels, Window, px};

pub use material::Place;
use material::Settings;
pub use presence::{Presence, on_glass, presence, with_presence, without_presence};

use crate::ui::context::Ds;

/// Which tuning a glass paints with.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Profile {
    /// The native-matched material ([`material`]).
    Native,
    /// The owner's composer tuning ([`composer`]).
    Composer,
}

/// How a native glass element sits and responds.
#[derive(Clone, Copy)]
pub struct LiquidGlass {
    pub place: Place,
    /// Added to the fill's brightness (hover, press).
    pub lift: f32,
    /// Growth per side while pressed (pt), about the centre.
    pub grow: f32,
    /// The glass appears and leaves by this presence's opacity only, at the full material, on
    /// the same motion as its content (a glass is never faded by a parent's opacity).
    pub materialize: Presence,
    /// Which tuning paints the glass.
    profile: Profile,
    reduce_transparency: bool,
    increase_contrast: bool,
}

impl LiquidGlass {
    pub fn over_content() -> Self {
        Self {
            place: Place::Content,
            lift: 0.,
            grow: 0.,
            materialize: Presence::Static(1.),
            profile: Profile::Native,
            reduce_transparency: false,
            increase_contrast: false,
        }
    }

    pub fn on_glass(lift: f32, grow: f32) -> Self {
        Self {
            place: Place::OnGlass,
            lift,
            grow,
            materialize: Presence::Static(1.),
            profile: Profile::Native,
            reduce_transparency: false,
            increase_contrast: false,
        }
    }

    /// The composer card's glass: the owner's composer tuning ([`composer`]).
    pub fn composer() -> Self {
        Self {
            profile: Profile::Composer,
            ..Self::over_content()
        }
    }

    /// Follow the OS Reduce Transparency and Increase Contrast settings (LG research §6, §8.1.8).
    pub fn adapt(mut self, ds: &Ds) -> Self {
        self.reduce_transparency = ds.reduced_transparency();
        self.increase_contrast = ds.increased_contrast();
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
    if glass.profile == Profile::Composer {
        composer::paint(bounds, radii, dark, window);
        return;
    }
    let r = radii.max().as_f32();
    let circle = (w - h).abs() < 0.5 && r >= w / 2. - 0.5;
    let presence = glass.materialize;
    if matches!(presence, Presence::Static(t) if t <= 0.) {
        return;
    }
    let settings = Settings {
        reduce_transparency: glass.reduce_transparency,
        increase_contrast: glass.increase_contrast,
    };
    let m = material::material(dark, (w, h), circle, glass.place, settings);
    let appear = match presence {
        Presence::Static(_) => None,
        Presence::Moving {
            from,
            to,
            start_ms,
            timing,
        } => {
            // The glass appears and leaves by opacity only, at full material, so the lens
            // fades with its content exactly as a backdrop-filter under CSS opacity.
            Some(gpui::LayerMotion {
                opacity: (from, to),
                ..timing.motion(start_ms)
            })
        }
    };
    material::paint(
        bounds,
        radii,
        &m,
        glass.lift,
        glass.grow,
        appear.as_ref(),
        window,
    );
}
