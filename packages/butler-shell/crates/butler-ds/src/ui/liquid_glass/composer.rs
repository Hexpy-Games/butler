//! The composer card's glass: the owner's tuning from the gpui glass spike (2026-10-27, the
//! "v13 Dock" lens the owner chose for the composer in v16), as the first gpui shell shipped it
//! (`glass/mod.rs` in 86c16c22d): a wide fold over the whole half size, moderate frost, a thin
//! top rim light, a lifted middle, then the tint. Every other glass uses [`super::material`].
use gpui::{
    BackdropLens, Bounds, BoxShadow, Corners, Filter, PaintQuad, Pixels, Window, point, px,
};

use super::material::rgba;

/// The owner's composer frost (blur px) and tint alpha.
const BLUR: f32 = 7.21;
const TINT: f32 = 0.47;

/// The owner's composer lens (light from 115 degrees, fold 2.95 over the whole half size).
fn lens() -> BackdropLens {
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

/// Shadow, then the refracted, frosted backdrop, then the tint.
pub(super) fn paint(
    bounds: Bounds<Pixels>,
    radii: Corners<Pixels>,
    dark: bool,
    window: &mut Window,
) {
    let (tint, shadow) = if dark {
        (rgba(22, 23, 26, TINT), shadow(14., 34., 0.28))
    } else {
        (rgba(255, 255, 255, TINT), shadow(12., 28., 0.06))
    };
    window.paint_drop_shadows(bounds, radii, 0., std::slice::from_ref(&shadow));
    window.paint_backdrop_lens(bounds, radii, 0., &[Filter::Blur(px(BLUR))], lens());
    window.paint_quad(PaintQuad::new(bounds).background(tint).corner_radii(radii));
}

/// The composer's drop shadow: `0 y blur` black at `alpha`.
fn shadow(y: f32, blur: f32, alpha: f32) -> BoxShadow {
    BoxShadow {
        color: rgba(0, 0, 0, alpha).into(),
        offset: point(px(0.), px(y)),
        blur_radius: px(blur),
        spread_radius: px(0.),
        inset: false,
    }
}
