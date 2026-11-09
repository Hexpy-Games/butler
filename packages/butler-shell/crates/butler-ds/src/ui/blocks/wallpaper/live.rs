//! The live engine's host side (`glScene.ts` drawPrint, `glDraw.ts`, `glPrint.ts`,
//! `contentRect.ts`) for the module the renderer has shaders for: butler.riso-print, drawn as
//! one static frame through `Window::paint_wallpaper` (gpui_render `fragment_wallpaper`, modules
//! 4 density and 5 print). The passes rerun only when an input changes (size, scale, tone,
//! params, keep-outs, day-phase step); frames that redraw other content reuse their textures.
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use gpui::{
    AnyElement, Bounds, Corners, IntoElement as _, Pixels, Styled as _, WallpaperPaint,
    WallpaperPass, Window, canvas,
};

use super::WallpaperTone;
use crate::ui::blocks::prompt_suggestion_list::ContentRect;

/// The module the renderer has the print shaders for.
const RISO_PRINT: &str = "butler.riso-print";
/// `fragment_wallpaper` modules: the density pass and the print pass.
const DENSITY_MODULE: u32 = 4;
const PRINT_MODULE: u32 = 5;
/// `WallpaperPass::source`: a density module samples the print's own noise. // DS: glDraw.ts:84
const PRINT_NOISE: u32 = 1;
/// `WallpaperPass::source`: the print pass samples the density pass (`u_density`).
const PREVIOUS_PASS: u32 = 2;
/// Density texels per CSS px. // DS: glPrint.ts:52
/// The drift render policy's pixel ratio and pixel budget. // DS: scheduler.ts:36
const MAX_PIXEL_RATIO: f32 = 1.5;
const MAX_PIXELS: f32 = 2_400_000.;
const DENSITY_SCALE: f32 = 0.25;
/// Day-phase steps a cached frame redraws at. // DS: glScene.ts:24
const DAY_PHASE_BUCKETS: f32 = 96.;
/// `u_seed` of a still. // DS: stillGpu.ts:16
const STILL_SEED: f32 = 0.5;
/// `u_dayPhase` of a still (midday), the default when the host gives none. // DS: stillGpu.ts:16
pub(super) const STILL_DAY_PHASE: f32 = 0.5;
/// `u_contentRect` / `u_contentRect2` when none is known. // DS: contentRect.ts:7
const NO_RECT: [f32; 4] = [0.; 4];

/// The print at rest (`restWallpaperPrintFrame`, glPrint.ts:26) at its still clock (riso-print
/// has no `stillTime`, so `u_time` is 0): what stills draw.
struct Rest {
    time: f32,
    flow: f32,
    lift: f32,
    pulse: f32,
    drop: [f32; 4],
    col: [f32; 4],
}

// ANIM-MIGRATE(riso drift: very slow continuous drift + stronger motion on events — driftCore.ts/driftController.ts)
const REST: Rest = Rest {
    time: 0.,
    flow: 0.,
    lift: 0.,
    pulse: 0.,
    drop: [0., 0., 1., 0.],
    col: [0.; 4],
};

/// butler.riso-print's params (`wallpaper.json`) as its shaders read them: option indices of
/// `inks`, `paper` and `composition`, and the `seed` number.
#[derive(Clone, Copy, Hash)]
struct RisoParams {
    inks: u8,
    paper: u8,
    composition: u8,
    seed: u8,
}

impl RisoParams {
    /// The manifest defaults: print inks, day paper (`defaultDark` night), masses, print 0.
    fn defaults(tone: WallpaperTone) -> Self {
        Self {
            inks: 0,
            paper: u8::from(tone == WallpaperTone::Dark),
            composition: 0,
            seed: 0,
        }
    }

    /// `wp_p0` = (p_inks, p_paper, p_composition, p_seed).
    fn uniform(self) -> [f32; 4] {
        [
            f32::from(self.inks),
            f32::from(self.paper),
            f32::from(self.composition),
            f32::from(self.seed),
        ]
    }
}

/// What a live frame is drawn from besides its bounds.
#[derive(Clone, Copy)]
pub(super) struct LiveFrame {
    pub(super) tone: WallpaperTone,
    /// `u_dayPhase`, 0..1.
    pub(super) day_phase: f32,
    /// `contentRect` in window px.
    pub(super) content_rect: Option<ContentRect>,
    /// `contentRect2` (the composer) in window px.
    pub(super) content_rect2: Option<ContentRect>,
}

/// The layer for a live module the renderer draws; `None` for any other module.
pub(super) fn layer(module: &str, frame: LiveFrame) -> Option<AnyElement> {
    if module != RISO_PRINT {
        return None;
    }
    let params = RisoParams::defaults(frame.tone);
    let key = paint_key(module, frame.tone, params);
    let element = canvas(
        |_, _, _| (),
        move |bounds, (), window, _| paint(bounds, key, params, frame, window),
    )
    .size_full()
    .into_any_element();
    Some(element)
}

/// What both passes share.
struct Shared {
    dark: f32,
    day_phase: f32,
    css: [f32; 2],
    density: [f32; 2],
    params: [f32; 4],
}

/// The density pass at 1 texel per 4 CSS px (keep-outs scaled into it), then the print pass
/// over it at device pixels. // DS: glScene.ts:63-80
fn paint(
    bounds: Bounds<Pixels>,
    key: u64,
    params: RisoParams,
    frame: LiveFrame,
    window: &mut Window,
) {
    let css = [f32::from(bounds.size.width), f32::from(bounds.size.height)];
    if css[0] < 1. || css[1] < 1. {
        return;
    }
    // `wallpaperCanvasSize` with the drift policy (scheduler.ts:36, 60-62: pixel ratio at most
    // 1.5, at most 2.4M pixels): the buffer Electron draws riso into; the composite scales it to
    // the bounds. Rounded for the canvas, up for the density target. // DS: glPrint.ts:56
    let base = window.scale_factor().min(MAX_PIXEL_RATIO);
    let target = (css[0] * css[1] * base * base).max(1.);
    let scale = base.min((MAX_PIXELS / target).sqrt() * base);
    let buffer = [
        (css[0] * scale).round().max(2.),
        (css[1] * scale).round().max(2.),
    ];
    let density = [
        (css[0] * DENSITY_SCALE).ceil().max(1.),
        (css[1] * DENSITY_SCALE).ceil().max(1.),
    ];
    let shared = Shared {
        dark: f32::from(u8::from(frame.tone == WallpaperTone::Dark)),
        day_phase: (frame.day_phase * DAY_PHASE_BUCKETS).floor() / DAY_PHASE_BUCKETS,
        css,
        density,
        params: params.uniform(),
    };
    let rect = buffer_rect(frame.content_rect, bounds, buffer);
    let (sx, sy) = (density[0] / buffer[0], density[1] / buffer[1]);
    let scaled = |r: [f32; 4]| [r[0] * sx, r[1] * sy, r[2] * sx, r[3] * sy];
    let rect2 = buffer_rect(frame.content_rect2, bounds, buffer);
    let density_ratio = density[0] / css[0];
    let passes = [
        pass(
            DENSITY_MODULE,
            density,
            PRINT_NOISE,
            uniforms(
                density,
                density_ratio,
                [scaled(rect), scaled(rect2)],
                &shared,
            ),
        ),
        pass(
            PRINT_MODULE,
            buffer,
            PREVIOUS_PASS,
            uniforms(buffer, scale, [rect, rect2], &shared),
        ),
    ];
    let wallpaper = WallpaperPaint {
        key,
        generation: generation(&passes),
        passes: passes.into(),
    };
    window.paint_wallpaper(bounds, Corners::default(), 1., wallpaper);
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a pass size is a rounded, positive pixel count of a window-sized buffer"
)]
fn pass(module: u32, size: [f32; 2], source: u32, uniforms: [[f32; 4]; 15]) -> WallpaperPass {
    WallpaperPass {
        module,
        width: size[0] as u32,
        height: size[1] as u32,
        source,
        uniforms,
    }
}

/// One pass's engine uniforms, in `BlurUniforms::wallpaper_pass` order (`wp_mode` is the
/// renderer's). // DS: glDraw.ts:81-101, glPrint.ts:31-40
fn uniforms(
    resolution: [f32; 2],
    pixel_ratio: f32,
    rects: [[f32; 4]; 2],
    shared: &Shared,
) -> [[f32; 4]; 15] {
    let mut u = [[0.; 4]; 15];
    // u_resolution, u_pixelRatio, u_time
    u[1] = [resolution[0], resolution[1], pixel_ratio, REST.time];
    // u_dark, u_dayPhase, u_seed
    u[2] = [shared.dark, shared.day_phase, STILL_SEED, 0.];
    // u_contentRect
    u[3] = rects[0];
    // u_css, u_flow, u_lift
    u[4] = [shared.css[0], shared.css[1], REST.flow, REST.lift];
    // u_pulse; the density target's size (the print samples it)
    u[5] = [REST.pulse, shared.density[0], shared.density[1], 0.];
    u[6] = REST.drop;
    u[7] = REST.col;
    // u_contentRect2: the composer keep-out
    u[8] = rects[1];
    u[9] = shared.params;
    u
}

/// `wallpaperContentRectUniform`: the rect clipped to the canvas, in drawing-buffer px with a
/// bottom-left origin; none when unknown, empty or off-canvas. // DS: contentRect.ts:21-36
fn buffer_rect(rect: Option<ContentRect>, area: Bounds<Pixels>, buffer: [f32; 2]) -> [f32; 4] {
    let Some(rect) = rect else {
        return NO_RECT;
    };
    let (canvas_left, canvas_top) = (f32::from(area.left()), f32::from(area.top()));
    let (width, height) = (f32::from(area.size.width), f32::from(area.size.height));
    let left = (rect.x - canvas_left).max(0.);
    let top = (rect.y - canvas_top).max(0.);
    let right = (rect.x + rect.width - canvas_left).min(width);
    let bottom = (rect.y + rect.height - canvas_top).min(height);
    if !(right > left && bottom > top) {
        return NO_RECT;
    }
    let (sx, sy) = (buffer[0] / width, buffer[1] / height);
    [
        left * sx,
        (height - bottom) * sy,
        (right - left) * sx,
        (bottom - top) * sy,
    ]
}

/// The textures' cache identity: module, tone, params and seed (the size lives in the passes).
fn paint_key(module: &str, tone: WallpaperTone, params: RisoParams) -> u64 {
    let mut hasher = DefaultHasher::new();
    module.hash(&mut hasher);
    tone.as_str().hash(&mut hasher);
    params.hash(&mut hasher);
    STILL_SEED.to_bits().hash(&mut hasher);
    hasher.finish()
}

/// Changes exactly when a pass's size or uniforms do, so the passes rerun once per change.
fn generation(passes: &[WallpaperPass]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for pass in passes {
        (pass.module, pass.width, pass.height, pass.source).hash(&mut hasher);
        for value in pass.uniforms.iter().flatten() {
            value.to_bits().hash(&mut hasher);
        }
    }
    hasher.finish()
}
