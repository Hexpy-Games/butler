//! The mark's geometry in the 1200 x 1200 design space (thinking-mark/constants.ts,
//! ribbon-geometry.ts, morph-outline.ts): two opposing rounded sectors (the ribbon) inside a
//! ring, and the outline that morphs from the ribbon into the moon's disc.
use std::sync::OnceLock;

pub(super) const DESIGN: f32 = 1200.;
pub(super) const CENTER: f32 = DESIGN / 2.;
/// Radius of the two opposing ribbon sectors.
const RR: f32 = 329.43;
/// Corner rounding of the ribbon sectors.
const RHO: f32 = 34.;
pub(super) const RING_R: f32 = 435.;
pub(super) const RING_W: f32 = 74.;
/// Radius of the lit moon sphere the bowtie rounds into.
pub(super) const HS_R: f32 = 288.;
/// Halftone cells live inside this disc (inside the ring).
pub(super) const DISC_R: f32 = 392.;
/// Half-angle of each ribbon sector: `atan2(136, 300)`.
fn half_angle() -> f32 {
    136f32.atan2(300.)
}

/// Signed distance to a circular sector (Inigo Quilez sdPie), axis along +y.
fn sd_pie(px: f32, py: f32, radius: f32) -> f32 {
    let (sin, cos) = half_angle().sin_cos();
    let ax = px.abs();
    let l = ax.hypot(py) - radius;
    let d = (ax * sin + py * cos).clamp(0., radius);
    let m = (ax - sin * d).hypot(py - cos * d);
    l.max(m * (cos * ax - sin * py).signum())
}

/// Signed distance to the rounded ribbon: both lobes, minus the rounding.
pub(super) fn sd_ribbon(x: f32, y: f32) -> f32 {
    let (dx, dy) = (x - CENTER, y - CENTER);
    sd_pie(dy, -dx, RR).min(sd_pie(dy, dx, RR)) - RHO
}

/// The morphing outline as a signed distance: the ribbon's blended into the moon's disc by `g`.
pub(super) fn morph_sd(sr: f32, dc: f32, g: f32, br: f32) -> f32 {
    sr + (dc - HS_R * br - sr) * g
}

const MAX_R: f32 = 440.;
const BISECT: usize = 12;

/// The radius of the morphing outline along each of `rays` rays from the centre (the first
/// zero of [`morph_sd`]; every blend of the ribbon and the disc is star-shaped about it).
pub(super) fn trace_outline(g: f32, br: f32, rays: usize) -> Vec<f32> {
    (0..rays)
        .map(|n| {
            let angle = n as f32 / rays as f32 * std::f32::consts::TAU;
            let (dy, dx) = angle.sin_cos();
            let (mut lo, mut hi) = (0f32, MAX_R);
            for _ in 0..BISECT {
                let mid = f32::midpoint(lo, hi);
                let sd = sd_ribbon(CENTER + dx * mid, CENTER + dy * mid);
                if morph_sd(sd, mid, g, br) <= 0. {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            f32::midpoint(lo, hi)
        })
        .collect()
}

/// The ribbon at rest: the exact logo outline, traced once.
pub(super) fn rest_outline() -> &'static [f32] {
    static REST: OnceLock<Vec<f32>> = OnceLock::new();
    REST.get_or_init(|| trace_outline(0., 1., 360))
}
