//! Liquid Glass through the Butler gpui-ce lens (tag butler-lens-1), with the owner's v18
//! defaults:
//! - the composer: the v13 Dock-style lens with the owner's v13 composer values (a wide fold
//!   over the whole half size, moderate frost, a thin top rim light, a lifted middle);
//! - every other glass element (dialog, round buttons, controls on glass): the native-matched
//!   material ([`native`]) at the owner's hairline strength.
//!
//! Children painted after a glass layer stay sharp above it.
mod native;
pub(crate) mod press;

use gpui::{
    BackdropLens, Bounds, Corners, Div, Filter, Hsla, PaintQuad, Pixels, canvas, div, prelude::*,
    px,
};

pub(crate) use native::{Place, paint_fill};

use crate::ui::theme::{Theme, rgba};

/// The owner's v13 composer tuning: frost (blur px) and tint alpha.
const COMPOSER_BLUR: f32 = 7.21;
const COMPOSER_TINT: f32 = 0.47;

/// The composer's v13 lens (light from 115 degrees, fold 2.95 over the whole half size).
fn composer_lens() -> BackdropLens {
    BackdropLens {
        bezel: 22.,
        refraction: 24.,
        specular: 0.31,
        depth: 13.,
        rim: 0.80,
        lift: 0.03,
        light_angle: 115f32.to_radians(),
        fresnel: 0.04,
        focus: 3.40,
        ambient: -0.02,
        halo: 0.09,
        fold: 2.95,
        fold_band: 1.,
        fold_depth: 1.,
        ..BackdropLens::default()
    }
}

/// The composer card: a relative, rounded box whose first child paints its glass. The 1px
/// border stays in layout (transparent) so the card keeps the DS geometry.
pub(crate) fn composer_surface(theme: &Theme, radius: f32) -> Div {
    let t = theme.clone();
    div()
        .relative()
        .rounded(px(radius))
        .border_1()
        .border_color(gpui::transparent_black())
        .child(
            canvas(
                |_, _, _| (),
                move |bounds, (), window, _| paint_composer(bounds, radius, &t, window),
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
}

/// Shadow, then the refracted, frosted backdrop, then the tint.
fn paint_composer(bounds: Bounds<Pixels>, radius: f32, theme: &Theme, window: &mut gpui::Window) {
    let (w, h) = (bounds.size.width.as_f32(), bounds.size.height.as_f32());
    let radii = Corners::all(px(radius.min(w / 2.).min(h / 2.)));
    let tint = if theme.dark {
        rgba(22, 23, 26, COMPOSER_TINT)
    } else {
        rgba(255, 255, 255, COMPOSER_TINT)
    };
    let blur = [Filter::Blur(px(COMPOSER_BLUR))];
    window.paint_drop_shadows(bounds, radii, 0., std::slice::from_ref(&theme.glass_shadow));
    window.paint_backdrop_lens(bounds, radii, 0., &blur, composer_lens());
    window.paint_quad(PaintQuad::new(bounds).background(tint).corner_radii(radii));
}

/// How a native glass element sits and responds.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Native {
    pub(crate) place: Place,
    /// Added to the fill's brightness (hover, press).
    pub(crate) lift: f32,
    /// Growth per side while pressed (pt), about the centre.
    pub(crate) grow: f32,
}

impl Native {
    pub(crate) fn over_content() -> Self {
        Self {
            place: Place::Content,
            lift: 0.,
            grow: 0.,
        }
    }

    pub(crate) fn on_glass(lift: f32, grow: f32) -> Self {
        Self {
            place: Place::OnGlass,
            lift,
            grow,
        }
    }
}

/// A native glass layer filling its (relative) parent.
pub(crate) fn layer(theme: &Theme, radius: f32, glass: Native) -> impl IntoElement {
    let dark = theme.dark;
    canvas(
        |_, _, _| (),
        move |bounds, (), window, _| {
            let (w, h) = (bounds.size.width.as_f32(), bounds.size.height.as_f32());
            if w < 1. || h < 1. {
                return;
            }
            let r = radius.min(w / 2.).min(h / 2.);
            let circle = (w - h).abs() < 0.5 && r >= w / 2. - 0.5;
            let m = native::material(dark, w, h, circle, glass.place);
            native::paint(bounds, r, &m, glass.lift, glass.grow, window);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// The veil under a dialog at full open (native alert dimming: 0.4 bg + 102 light, 0.39 bg
/// + 14 dark, as the owner tuned it: alpha 0.60).
pub(crate) fn veil(dark: bool) -> Hsla {
    let grey = if dark { 23 } else { 170 };
    rgba(grey, grey, grey, 0.60)
}
