//! The halftone model (thinking-mark/halftone-model.ts): three fixed screens (key, riso blue,
//! fluorescent pink) of cells with the ribbon distance, emboss and sphere normals precomputed,
//! and the dot radius of each cell as a function of the morph.
use std::sync::OnceLock;

use super::geometry::{CENTER, DISC_R, HS_R, morph_sd, sd_ribbon};

/// Pitch (design units) and misregistration scale per size class: <20px, 20-63px, >=64px.
const PRESETS: [(f32, f32); 3] = [(100., 2.6), (64., 1.8), (25., 1.)]; // DS: constants.ts:55
/// Screen angles: key ink 45deg, riso blue 15deg, fluorescent pink 75deg.
const ANGLES: [f32; 3] = [
    std::f32::consts::FRAC_PI_4,
    std::f32::consts::PI / 12.,
    std::f32::consts::PI * 5. / 12.,
];
const WAVE: f32 = 0.2; // DS: constants.ts:63
const SWEEP: f32 = 1.9; // DS: constants.ts:65
const LIGHT_PHASE: f32 = 2.3; // DS: constants.ts:67
const LIGHT_RATE: f32 = 1.1; // DS: constants.ts:68
/// Below this coverage a dot has shrunk to nothing.
const COVERAGE_FLOOR: f32 = 0.004;

pub(super) fn size_class(side: f32) -> usize {
    if side >= 64. {
        2
    } else {
        usize::from(side >= 20.)
    }
}

pub(super) fn pitch_of(class: usize) -> f32 {
    PRESETS[class].0
}

pub(super) fn mis_of(class: usize) -> f32 {
    PRESETS[class].1
}

pub(super) struct Cell {
    pub(super) x: f32,
    pub(super) y: f32,
    sr: f32,
    dc: f32,
    emboss: [f32; 3],
    sphere: [f32; 3],
}

pub(super) struct Layer {
    pub(super) cells: Vec<Cell>,
    pitch: f32,
}

fn emboss_height(x: f32, y: f32) -> f32 {
    (-sd_ribbon(x, y) / 120.).clamp(0., 1.).sqrt()
}

fn build_layer(angle: f32, pitch: f32) -> Layer {
    let (sa, ca) = angle.sin_cos();
    let eps = 8.;
    let mut cells = Vec::new();
    let mut row = -440.;
    while row <= 440. {
        let mut col = -440.;
        while col <= 440. {
            let x = CENTER + col * ca - row * sa;
            let y = CENTER + col * sa + row * ca;
            let dc = (x - CENTER).hypot(y - CENTER);
            if dc <= DISC_R {
                let hx =
                    (emboss_height(x + eps, y) - emboss_height(x - eps, y)) / (2. * eps) * 120.;
                let hy =
                    (emboss_height(x, y + eps) - emboss_height(x, y - eps)) / (2. * eps) * 120.;
                let nl = (hx * hx + hy * hy + 1.).sqrt();
                let sx = (x - CENTER) / HS_R;
                let sy = (y - CENTER) / HS_R;
                let sz = (1. - sx * sx - sy * sy).max(0.02).sqrt();
                let sl = (sx * sx + sy * sy + sz * sz).sqrt();
                cells.push(Cell {
                    x,
                    y,
                    sr: sd_ribbon(x, y),
                    dc,
                    emboss: [-hx / nl, -hy / nl, 1. / nl],
                    sphere: [sx / sl, sy / sl, sz / sl],
                });
            }
            col += pitch;
        }
        row += pitch;
    }
    Layer { cells, pitch }
}

/// The three screens of a size class, built once and shared by every mark.
pub(super) fn lattice(class: usize) -> &'static [Layer; 3] {
    static LATTICES: [OnceLock<[Layer; 3]>; 3] =
        [OnceLock::new(), OnceLock::new(), OnceLock::new()];
    LATTICES[class].get_or_init(|| ANGLES.map(|angle| build_layer(angle, PRESETS[class].0)))
}

/// Per-frame parameters.
pub(super) struct Frame {
    /// Morph progress.
    pub(super) m: f32,
    /// The motion clock.
    pub(super) t: f32,
    pub(super) br: f32,
    light: [f32; 3],
}

impl Frame {
    pub(super) fn new(m: f32, t: f32) -> Self {
        // The riso moon: the light orbits briskly with a gentle bob.
        let phi = LIGHT_PHASE + LIGHT_RATE * t;
        let el = 0.95 + 0.18 * (t * 0.9).sin();
        Self {
            m,
            t,
            br: 1. + 0.025 * (t * 1.3).sin(),
            light: [phi.cos() * el.sin(), phi.sin() * el.sin() * 0.85, el.cos()],
        }
    }

    /// Moon tone: one Lambert term plus a small specular, on normals blended emboss to sphere.
    fn tone(&self, cell: &Cell) -> f32 {
        let m = self.m;
        let n: [f32; 3] =
            std::array::from_fn(|i| cell.emboss[i] + (cell.sphere[i] - cell.emboss[i]) * m);
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        let (nx, ny, nz) = (n[0] / len, n[1] / len, n[2] / len);
        let [lx, ly, lz] = self.light;
        let lambert = (nx * lx + ny * ly + nz * lz).max(0.);
        let hz = nz * 0.5 + 0.5 * lz;
        let spec = (nx * lx * 0.5 + ny * ly * 0.5 + hz).max(0.).powf(16.) * 0.25;
        (0.1 + 0.9 * lambert + spec).clamp(0., 1.)
    }

    /// Dot radius (design units) of `cell` on screen `ink` (0 key, 1 blue, 2 pink); 0 is no dot.
    pub(super) fn dot_radius(&self, layer: &Layer, cell: &Cell, ink: usize) -> f32 {
        let (pitch, g) = (layer.pitch, self.m);
        let sd = morph_sd(cell.sr, cell.dc, g, self.br);
        // Fused at rest (+0.7 spill), a crisp screen once formed.
        let mask = (0.5 - sd / (pitch * 0.7) + 0.7 * (1. - g)).clamp(0., 1.);
        if mask <= 0. {
            return 0.;
        }
        let tone = self.tone(cell);
        let s = g * (0.35 + 0.65 * g);
        // A ripple of dot size travelling outward, and a diagonal sweep that trades blue and pink.
        let ripple = 1. + WAVE * g * (cell.dc / 46. - self.t * 3.1).sin();
        let cov = if ink == 0 {
            mask * (1. + (tone - 1.) * s) * ripple
        } else {
            let sw = 0.5 + 0.5 * ((cell.x * 0.72 + cell.y * 0.69) / 150. - self.t * SWEEP).sin();
            mask * (1. - tone) * 0.9 * s * if ink == 1 { 1. - sw } else { sw } * ripple
        };
        if cov <= COVERAGE_FLOOR {
            return 0.;
        }
        pitch * (0.8 - 0.16 * g) * (cov - COVERAGE_FLOOR).min(1.25).sqrt()
    }
}
