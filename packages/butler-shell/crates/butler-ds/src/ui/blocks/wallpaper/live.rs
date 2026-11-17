//! Window-sized frames of the live modules. // DS: stillGpu.ts, glScene.ts.
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use gpui::{
    AnyElement, App, Bounds, Corners, IntoElement as _, Pixels, Styled as _, WallpaperClock,
    WallpaperImage, WallpaperPaint, WallpaperPass, Window, canvas,
};

use super::live_modules::IMAGE_MODULE;
use super::{
    ImageFilter, ImageFit, WallpaperHost, WallpaperParams, WallpaperTone, drift, live_image,
    live_modules, live_params, live_print,
    watchdog::{self, Watchdog},
};
use crate::ui::blocks::prompt_suggestion_list::ContentRect;

pub(super) use live_print::intro_layer;
// DS: stillGpu.ts STILL_FRAME.
pub(super) const STILL_DAY_PHASE: f32 = 0.5;

#[derive(Clone, Copy)]
pub(super) struct LiveFrame {
    pub(super) tone: WallpaperTone,
    pub(super) host: WallpaperHost,
    pub(super) animate: bool,
    pub(super) start_ms: u32,
    pub(super) day_phase: f32,
    pub(super) content_rect: Option<ContentRect>,
    pub(super) content_rect2: Option<ContentRect>,
    pub(super) column: Option<[f32; 3]>,
}

/// A picture to draw under a module, with how to fit and blur it.
#[derive(Clone)]
pub(super) struct ImageInput {
    pub(super) image: Option<WallpaperImage>,
    pub(super) fit: ImageFit,
    pub(super) blur: f32,
}

/// Known modules never fall back to posters, including while a photo is decoding.
pub(super) fn layer(
    id: &str,
    values: &WallpaperParams,
    frame: LiveFrame,
    window: &mut Window,
    cx: &mut App,
) -> Option<(AnyElement, f32)> {
    let module = live_modules::get(id)?;
    let input = ImageInput {
        image: module
            .photo
            .as_ref()
            .and_then(|photo| live_image::load(photo, cx)),
        fit: ImageFit::Cover,
        blur: 0.,
    };
    let params = live_params::resolve(&module.manifest, values, frame.tone);
    let mut hash = DefaultHasher::new();
    id.hash(&mut hash);
    frame.tone.as_str().hash(&mut hash);
    let brightness = module
        .photo
        .as_ref()
        .map_or(1., |_| module.brightness(module.default_dim(), frame.tone));
    let drawn = draw(module, hash.finish(), input, params, frame, window, cx);
    Some((drawn, brightness))
}

/// An image wallpaper: the picture fitted and blurred by `butler.image`, or under the filter
/// module when it takes an image; its brightness is what the dim leaves.
// DS: glScene.ts imageInput, drawWallpaperScene.
#[expect(
    clippy::too_many_arguments,
    reason = "the source's fields, the frame and the window context"
)]
pub(super) fn image_layer(
    picture: WallpaperImage,
    fit: ImageFit,
    blur: f32,
    dim: f32,
    filter: Option<&ImageFilter>,
    frame: LiveFrame,
    window: &mut Window,
    cx: &mut App,
) -> (AnyElement, f32) {
    let filter = filter.and_then(|filter| {
        live_modules::get(&filter.module)
            .filter(|module| module.manifest["image"] != "none")
            .map(|module| (module, filter))
    });
    let (module, values) = match filter {
        Some((module, filter)) => (module, filter.values.clone()),
        None => (live_modules::image(), WallpaperParams::default()),
    };
    let params = live_params::resolve(&module.manifest, &values, frame.tone);
    let mut hash = DefaultHasher::new();
    module.manifest["id"].as_str().hash(&mut hash);
    frame.tone.as_str().hash(&mut hash);
    picture.id.hash(&mut hash);
    (fit == ImageFit::Contain).hash(&mut hash);
    filter.map(|(_, filter)| &filter.module).hash(&mut hash);
    let input = ImageInput {
        image: Some(picture),
        fit,
        blur,
    };
    let drawn = draw(module, hash.finish(), input, params, frame, window, cx);
    (drawn, module.brightness(dim, frame.tone))
}

fn draw(
    module: &'static live_modules::Module,
    key: u64,
    input: ImageInput,
    params: [[f32; 4]; 6],
    frame: LiveFrame,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let watchdog =
        window.use_keyed_state(("wallpaper-watchdog", key), cx, |_, _| Watchdog::default());
    let mut frame = frame;
    frame.animate &= !watchdog.read(cx).degraded();
    if module.manifest["motion"] == "drift" {
        return drift::layer(key, params[0], frame, module, window, cx);
    }
    let watchdog = watchdog.clone();
    canvas(
        |_, _, _| (),
        move |bounds, (), window, cx| {
            if (module.photo.is_some() || module.manifest["image"] == "required")
                && input.image.is_none()
            {
                return;
            }
            let mut frame = frame;
            if bounds.size.width > gpui::px(0.) && bounds.size.height > gpui::px(0.) {
                frame.start_ms =
                    crate::ui::motion::mounted_at(("wallpaper-clock", key), window, cx);
            }
            if module.manifest["density"] == true {
                live_print::paint(
                    bounds,
                    key,
                    params[0],
                    frame,
                    live_print::REST.flow,
                    module,
                    window,
                );
            } else if paint(bounds, key, module, params, input.clone(), frame, window) {
                let watchdog = watchdog.clone();
                window.on_slow_animation_frames(
                    watchdog::SLOW_RENDER,
                    watchdog::SLOW_FRAMES,
                    move |_, cx| watchdog.update(cx, Watchdog::degrade),
                );
            }
        },
    )
    .size_full()
    .into_any_element()
}

fn paint(
    bounds: Bounds<Pixels>,
    key: u64,
    module: &live_modules::Module,
    params: [[f32; 4]; 6],
    input: ImageInput,
    frame: LiveFrame,
    window: &mut Window,
) -> bool {
    let css = [f32::from(bounds.size.width), f32::from(bounds.size.height)];
    if css[0] < 1. || css[1] < 1. {
        return false;
    }
    let (ratio, budget) = module.policy();
    let (buffer, pixel_ratio) = live_print::buffer_size(css, window.scale_factor(), ratio, budget);
    let mut u = [[0.; 4]; 15];
    u[1] = [buffer[0], buffer[1], pixel_ratio, module.time()];
    u[2] = [
        f32::from(u8::from(frame.tone == WallpaperTone::Dark)),
        (frame.day_phase * 96.).floor() / 96.,
        0.5,
        0.,
    ];
    u[3] = live_print::buffer_rect(frame.content_rect, bounds, buffer);
    u[4] = [css[0], css[1], 0., 0.];
    u[8] = live_print::buffer_rect(frame.content_rect2, bounds, buffer);
    u[9..15].copy_from_slice(&params);
    let passes = passes(module, buffer, u, &input);
    let prefit = input.image.is_some() && module.shaders[0] != IMAGE_MODULE;
    let clock = clock(module, frame, prefit);
    let animated = clock.is_some();
    let wallpaper = WallpaperPaint {
        key,
        generation: live_print::generation(&passes),
        clock,
        image: input.image,
        passes: passes.into(),
    };
    window.paint_wallpaper(bounds, Corners::default(), 1., wallpaper);
    animated
}

/// DS: glScene.ts: prefit (none for `butler.image`, which fits itself) → base (time 0 for
/// overlays) → overlay.
fn passes(
    module: &live_modules::Module,
    buffer: [f32; 2],
    mut u: [[f32; 4]; 15],
    input: &ImageInput,
) -> Vec<WallpaperPass> {
    let mut passes = Vec::new();
    if let Some(image) = &input.image {
        let mut fitted = u;
        live_image::fit(image, input.fit, input.blur, buffer, &mut fitted);
        let mut pass = pass(IMAGE_MODULE, buffer, false, fitted);
        pass.image = true;
        passes.push(pass);
        if module.shaders[0] == IMAGE_MODULE {
            return passes;
        }
        u[2][3] = buffer[0] / buffer[1];
        u[7][3] = 1.;
    }
    let overlay = module.manifest["overlay"] == true;
    let time = u[1][3];
    if overlay {
        u[1][3] = 0.;
    }
    passes.push(pass(module.shaders[0], buffer, input.image.is_some(), u));
    if overlay {
        u[1][3] = time;
        passes.push(pass(module.shaders[1], buffer, true, u));
    }
    passes
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "buffer dimensions are rounded positive window pixel counts"
)]
fn pass(module: u32, buffer: [f32; 2], previous: bool, uniforms: [[f32; 4]; 15]) -> WallpaperPass {
    WallpaperPass {
        module,
        width: buffer[0] as u32,
        height: buffer[1] as u32,
        noise: 0,
        previous,
        image: false,
        uniforms,
    }
}

/// DS: scheduler.ts WALLPAPER_ANIMATED_FPS and wallpaperFrameMode, glScene.ts pass order.
#[expect(
    clippy::cast_possible_truncation,
    reason = "shader period is an f32 uniform"
)]
fn clock(module: &live_modules::Module, frame: LiveFrame, prefit: bool) -> Option<WallpaperClock> {
    (frame.animate && module.manifest["motion"] == "animated").then(|| WallpaperClock {
        start_ms: frame.start_ms,
        start_s: module.still_time,
        fps: 20, // DS: scheduler.ts WALLPAPER_ANIMATED_FPS.
        period_s: module.period() as f32,
        animated_from: usize::from(prefit) + usize::from(module.manifest["overlay"] == true),
    })
}
