//! Native-matched Liquid Glass (macOS 27 "regular" glass), fitted to captures of the real
//! material over controlled backdrops (2x px; 1 pt = 2 px). Everything that native glass
//! changes with size follows the element's smaller dimension `s` (pt):
//! - fill: a tone curve on the backdrop (out = a + b x + c x^2, measured over black, grey and
//!   white), interpolated from the small (<= 64 pt) to the large (>= 140 pt; dark >= 110 pt) fit;
//! - frost: the backdrop is frosted (Gaussian) and the sharp backdrop is mixed back at weight
//!   `detail`, so small glass keeps sharp, low-contrast detail and >= 120 pt none;
//! - refraction: the backdrop is pulled from further in near the edge, mirrored and squeezed in a
//!   band of 20-30 pt (the fold mapping), offsets per the measured table;
//! - shadow: none below 64 pt, then deeper and wider, offset downward; dark 1.5x;
//! - rim: a bright ~2 px line on the top and bottom edges only (|normal.y|^focus);
//! - hairline: a 1 px dark line just outside the silhouette, strong on the left and right
//!   edges, weak on top and bottom, drawn by the lens shader at the owner's strength (0.31).
use gpui::{BackdropLens, Bounds, BoxShadow, Corners, Filter, Hsla, Pixels, Rgba, point, px, size};

/// sRGB 0..255 plus alpha as an `Hsla`.
fn rgba(r: u8, g: u8, b: u8, a: f32) -> Hsla {
    gpui::rgb_to_hsla(Rgba::new(
        f32::from(r) / 255.,
        f32::from(g) / 255.,
        f32::from(b) / 255.,
        a,
    ))
}

/// The owner's hairline strength (a multiplier on the measured native hairline).
const HAIRLINE: f32 = 0.31;
/// Rim glow, the |normal.y| exponent and the frost's Gaussian sigma (pt).
const GLOW: f32 = 0.14;
const FOCUS: f32 = 3.;
const BLUR: f32 = 12.;

/// What sits under the glass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    /// Over content: its own shadow.
    Content,
    /// A separate glass element on another glass (own rim, hairline and fill, no shadow).
    OnGlass,
}

/// What changes the material beyond the element's size: how far it has materialized and the
/// OS display settings.
#[derive(Clone, Copy, Debug)]
pub(super) struct Settings {
    /// 0..=1: the lens ramps from identity to the full material (LG research §5 Appear/disappear).
    pub(super) materialize: f32,
    /// OS Reduce Transparency (LG research §6).
    pub(super) reduce_transparency: bool,
    /// OS Increase Contrast (LG research §6).
    pub(super) increase_contrast: bool,
}

/// The material of one element at its size.
#[derive(Clone, Debug)]
pub(super) struct Material {
    /// The frost's Gaussian sigma (pt).
    blur: f32,
    halo: f32,
    tone: [f32; 3],
    detail: f32,
    rim: f32,
    fold: f32,
    /// Blur of the sharp detail (pt).
    detail_blur: f32,
    band_pt: f32,
    depth_pt: f32,
    hair_side: f32,
    hair_top: f32,
    shadow: Option<BoxShadow>,
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t.clamp(0., 1.)
}

/// Piecewise-linear table lookup (x ascending).
fn table(points: &[(f32, f32)], x: f32) -> f32 {
    let (Some(first), Some(last)) = (points.first(), points.last()) else {
        return 0.;
    };
    if x <= first.0 {
        return first.1;
    }
    for w in points.windows(2) {
        if let [a, b] = w
            && x <= b.0
        {
            return lerp(a.1, b.1, (x - a.0) / (b.0 - a.0));
        }
    }
    last.1
}

/// Fill tone curves (0..1 code values) fitted through the measured fill over black, grey 128
/// and white: light small 132/194/253, light large 136/203/254, dark small 32/134/184, dark
/// large 32/116/122.
const TONE_LIGHT_SMALL: [f32; 3] = [0.5176, 0.5022, -0.0292];
const TONE_LIGHT_LARGE: [f32; 3] = [0.5333, 0.5846, -0.1218];
const TONE_DARK_SMALL: [f32; 3] = [0.1255, 0.9990, -0.4029];
const TONE_DARK_LARGE: [f32; 3] = [0.1255, 0.9616, -0.6087];

fn tone(dark: bool, s: f32) -> [f32; 3] {
    let large = if dark {
        ((s - 64.) / 46.).clamp(0., 1.)
    } else {
        ((s - 64.) / 76.).clamp(0., 1.)
    };
    let (small, big) = if dark {
        (TONE_DARK_SMALL, TONE_DARK_LARGE)
    } else {
        (TONE_LIGHT_SMALL, TONE_LIGHT_LARGE)
    };
    [0, 1, 2].map(|i| lerp(small[i], big[i], large))
}

/// Rim step added to the fill: brighter on short straight-edged glass (capsules).
fn rim(dark: bool, circle: bool, s: f32) -> f32 {
    match (dark, circle) {
        (false, true) => table(&[(44., 0.093), (200., 0.103)], s),
        (false, false) => table(&[(48., 0.103), (140., 0.078)], s),
        (true, true) => table(&[(44., 0.115), (200., 0.126)], s),
        (true, false) => table(&[(48., 0.143), (140., 0.126)], s),
    }
}

/// Hairline alphas (side, top/bottom) per device pixel.
fn hairline(dark: bool, circle: bool, s: f32, strength: f32) -> (f32, f32) {
    let side = if dark {
        table(&[(64., 0.30), (140., 0.36), (360., 0.40)], s)
    } else {
        table(&[(64., 0.16), (140., 0.18), (360., 0.20)], s)
    };
    let top = match (dark, circle) {
        (false, true) => 0.03,
        (false, false) => table(&[(64., 0.04), (360., 0.07)], s),
        (true, _) => table(&[(96., 0.), (140., 0.02), (360., 0.03)], s),
    };
    (side * strength, top * strength)
}

/// The native material of a `w` x `h` pt element (`circle`: a round control).
pub(super) fn material(
    dark: bool,
    (w, h): (f32, f32),
    circle: bool,
    place: Place,
    settings: Settings,
) -> Material {
    let s = w.min(h);
    // Detail weight fitted to checker and thin-line captures; gone by 120 pt.
    let detail = if dark {
        table(&[(64., 0.33), (96., 0.27), (120., 0.)], s)
    } else {
        table(&[(64., 0.46), (96., 0.39), (120., 0.)], s)
    };
    let depth_pt = if circle {
        table(
            &[
                (44., 11.),
                (64., 10.7),
                (96., 16.),
                (140., 21.),
                (200., 24.),
            ],
            s,
        )
    } else {
        table(&[(48., 12.7), (140., 10.), (360., 18.5)], s)
    };
    let fold = if circle {
        table(&[(44., 2.2), (64., 4.2), (96., 4.4)], s)
    } else {
        table(&[(48., 3.7), (140., 4.4)], s)
    };
    // Increase Contrast keeps the hairline at full strength (LG research §6).
    let strength = if settings.increase_contrast {
        1.
    } else {
        HAIRLINE
    };
    let (hair_side, hair_top) = hairline(dark, circle, s, strength);
    let mut m = Material {
        blur: BLUR,
        halo: GLOW,
        tone: tone(dark, s),
        detail,
        rim: rim(dark, circle, s),
        fold,
        detail_blur: 0.,
        band_pt: table(&[(44., 20.), (64., 30.)], s),
        depth_pt,
        hair_side,
        hair_top,
        shadow: if place == Place::Content {
            shadow(dark, s, settings.materialize.clamp(0., 1.))
        } else {
            None
        },
    };
    m.detail_blur = match (m.detail <= 0., dark) {
        (true, _) => 0.,
        (false, true) => 0.6,
        (false, false) => 5.2,
    };
    adapt(&mut m, dark, place, settings);
    m
}

/// The research rules on top of the fitted material (every deviation cites its section).
fn adapt(m: &mut Material, dark: bool, place: Place, settings: Settings) {
    if place == Place::OnGlass {
        // Glass on glass is not a second lens: sharp (no frost), refraction at 20%, and an
        // identity tone so the parent's fill is not tinted twice (LG research §4.2, §8.1.4,
        // §8.3 "Buttons on dialog").
        m.blur = 0.;
        m.detail = 1.;
        m.detail_blur = 0.;
        m.fold *= 0.2;
        m.depth_pt *= 0.2;
        m.tone = IDENTITY;
    }
    if settings.reduce_transparency {
        // Frostier: no sharp mix, more blur, halfway to an opaque surface (LG research §6).
        m.detail = 0.;
        m.detail_blur = 0.;
        m.blur *= 1.5;
        let opaque = if dark { [0.12, 0., 0.] } else { [0.96, 0., 0.] };
        m.tone = [0, 1, 2].map(|i| lerp(m.tone[i], opaque[i], 0.5));
    }
    if settings.increase_contrast {
        // Near-opaque fill, half the refraction (LG research §6).
        m.tone = if dark { [0.08, 0., 0.] } else { [0.98, 0., 0.] };
        m.fold *= 0.5;
        m.depth_pt *= 0.5;
    }
    materialize(m, settings.materialize);
}

/// The lens at identity (the tone curve that leaves the backdrop as it is).
const IDENTITY: [f32; 3] = [0., 1., 0.];

/// Ramp the lens from identity to `m` by `t`: refraction, rim, halo, blur, shadow and hairline
/// scale with it (the shadow is built with it) and the tone moves from identity (LG research §5 Appear/disappear, §8.1.6).
fn materialize(m: &mut Material, t: f32) {
    let t = t.clamp(0., 1.);
    if t >= 1. {
        return;
    }
    m.fold *= t;
    m.depth_pt *= t;
    m.rim *= t;
    m.halo *= t;
    m.blur *= t;
    m.detail_blur *= t;
    m.hair_side *= t;
    m.hair_top *= t;
    m.tone = [0, 1, 2].map(|i| lerp(IDENTITY[i], m.tone[i], t));
}

/// Native shadow by size: none below 64 pt, then up to a 520 x 360 panel's; dark 1.5x.
fn shadow(dark: bool, s: f32, materialized: f32) -> Option<BoxShadow> {
    let grow = table(&[(64., 0.), (96., 0.38), (140., 0.77), (200., 1.)], s);
    // The alpha follows how far the glass has materialized (LG research §5, §8.1.6).
    let alpha = lerp(0.02, 0.12, grow) * (1. + if dark { 0.5 * grow } else { 0. }) * materialized;
    if alpha <= 0.001 {
        return None;
    }
    Some(BoxShadow {
        color: rgba(0, 0, 0, alpha.min(0.9)).into(),
        offset: point(px(0.), px(lerp(3., 8.5, grow))),
        blur_radius: px(lerp(6., 16., grow)),
        spread_radius: px(0.),
        inset: false,
    })
}

/// The lens for `m` on a shape whose smaller half side is `half` pt.
fn lens(m: &Material, half: f32, tone_offset: f32) -> BackdropLens {
    let half = half.max(1.);
    BackdropLens {
        // Any bevel activates the lens; with the fold on it only bounds the rim's glow reach.
        bezel: 22.,
        specular: m.rim,
        rim: 0.95,
        light_angle: 90f32.to_radians(),
        opposite: 1.,
        focus: FOCUS,
        halo: m.halo,
        fold: m.fold,
        fold_band: (m.band_pt / half).max(0.01),
        fold_depth: m.depth_pt / half,
        sharp_rim: m.detail,
        sharp_full: m.detail > 0.,
        frost: m.detail_blur,
        tone: [m.tone[0] + tone_offset, m.tone[1], m.tone[2]],
        exact: true,
        hairline: [m.hair_side.clamp(0., 1.), m.hair_top.clamp(0., 1.)],
        ..BackdropLens::default()
    }
}

/// Shadow and lens of one native glass element. `tone_offset` lifts the fill (hover / press);
/// `grow` (pt, per side) enlarges it about its centre while pressed. The rest shape is snapped
/// to device pixels as gpui would (crisp at rest), the growth is added in float and painted
/// with exact bounds, so the edge moves smoothly and the centre never shifts; the hairline is
/// drawn by the lens shader in the pixel ring outside that float shape.
pub(super) fn paint(
    bounds: Bounds<Pixels>,
    radii: Corners<Pixels>,
    m: &Material,
    tone_offset: f32,
    grow: f32,
    appear: Option<(Material, gpui::LayerMotion)>,
    window: &mut gpui::Window,
) {
    if bounds.size.width < px(1.) || bounds.size.height < px(1.) {
        return;
    }
    let shape = snapped(bounds, window.scale_factor(), grow, grow);
    let (w, h) = (shape.size.width.as_f32(), shape.size.height.as_f32());
    let radii = radii.map(|r| px((r.as_f32() + grow).min(w / 2.).min(h / 2.)));
    if let Some(shadow) = &m.shadow {
        if let Some((_, motion)) = &appear {
            window.with_motion(*motion, shape, |window| {
                window.paint_drop_shadows_outside(shape, radii, 0., std::slice::from_ref(shadow));
            });
        } else {
            window.paint_drop_shadows_outside(shape, radii, 0., std::slice::from_ref(shadow));
        }
    }
    let blur = [Filter::Blur(px(m.blur))];
    let half = w.min(h) / 2.;
    if let Some((m_from, motion)) = appear {
        window.paint_backdrop_lens_appearing(
            shape,
            radii,
            0.,
            &blur,
            lens(m, half, tone_offset),
            lens(&m_from, half, tone_offset),
            px(m_from.blur),
            motion,
        );
    } else {
        window.paint_backdrop_lens(shape, radii, 0., &blur, lens(m, half, tone_offset));
    }
}

/// The rest bounds snapped to device pixels like gpui's quads, grown per side by
/// `grow_x` / `grow_y` pt.
fn snapped(bounds: Bounds<Pixels>, sf: f32, grow_x: f32, grow_y: f32) -> Bounds<Pixels> {
    let (l, t) = (
        snap(bounds.left().as_f32(), sf),
        snap(bounds.top().as_f32(), sf),
    );
    let (r, b) = (
        snap(bounds.right().as_f32(), sf),
        snap(bounds.bottom().as_f32(), sf),
    );
    Bounds::new(
        point(px(l - grow_x), px(t - grow_y)),
        size(px(r - l + 2. * grow_x), px(b - t + 2. * grow_y)),
    )
}

/// gpui's device-pixel snapping of quad and lens bounds (round half toward zero).
fn snap(v: f32, scale: f32) -> f32 {
    let x = v * scale;
    (x.abs() - 0.5).ceil().copysign(x) / scale
}
