//! Window-sized frames of the live modules. // DS: stillGpu.ts, glScene.ts.
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use gpui::{
    AnyElement, App, Bounds, Corners, IntoElement as _, Pixels, Styled as _, WallpaperImage,
    WallpaperPaint, WallpaperPass, Window, canvas,
};

use super::{WallpaperTone, live_image, live_modules, live_params, live_print};
use crate::ui::blocks::prompt_suggestion_list::ContentRect;

pub(super) use live_print::intro_layer;
// DS: stillGpu.ts STILL_FRAME.
pub(super) const STILL_DAY_PHASE: f32 = 0.5;

#[derive(Clone, Copy)]
pub(super) struct LiveFrame {
    pub(super) tone: WallpaperTone,
    pub(super) day_phase: f32,
    pub(super) content_rect: Option<ContentRect>,
    pub(super) content_rect2: Option<ContentRect>,
}

/// Known modules never fall back to posters, including while a photo is decoding.
pub(super) fn layer(id: &str, frame: LiveFrame, cx: &mut App) -> Option<(AnyElement, f32)> {
    let module = live_modules::get(id)?;
    let image = module
        .photo
        .as_ref()
        .and_then(|photo| live_image::load(photo, cx));
    let params = live_params::defaults(&module.manifest, frame.tone);
    let mut hash = DefaultHasher::new();
    id.hash(&mut hash);
    frame.tone.as_str().hash(&mut hash);
    let key = hash.finish();
    let drawn = canvas(
        |_, _, _| (),
        move |bounds, (), window, _cx| {
            if (module.photo.is_some() && image.is_none())
                || (module.manifest["image"] == "required" && module.photo.is_none())
            {
                return;
            }
            if module.manifest["density"] == true {
                live_print::paint(bounds, key, params[0], frame, module, window);
            } else {
                paint(bounds, key, module, params, image.clone(), frame, window);
            }
        },
    )
    .size_full()
    .into_any_element();
    Some((drawn, module.brightness(frame.tone)))
}

fn paint(
    bounds: Bounds<Pixels>,
    key: u64,
    module: &live_modules::Module,
    params: [[f32; 4]; 6],
    image: Option<WallpaperImage>,
    frame: LiveFrame,
    window: &mut Window,
) {
    let css = [f32::from(bounds.size.width), f32::from(bounds.size.height)];
    if css[0] < 1. || css[1] < 1. {
        return;
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
    let passes = passes(module, buffer, u, image.as_ref());
    let wallpaper = WallpaperPaint {
        key,
        generation: live_print::generation(&passes),
        clock: None,
        image,
        passes: passes.into(),
    };
    window.paint_wallpaper(bounds, Corners::default(), 1., wallpaper);
}

/// DS: glScene.ts: prefit → base (time 0 for overlays) → overlay.
fn passes(
    module: &live_modules::Module,
    buffer: [f32; 2],
    mut u: [[f32; 4]; 15],
    image: Option<&WallpaperImage>,
) -> Vec<WallpaperPass> {
    let mut passes = Vec::new();
    if let Some(image) = image {
        let mut prefit = u;
        live_image::fit(image, buffer, &mut prefit);
        let mut pass = pass(17, buffer, false, prefit);
        pass.image = true;
        passes.push(pass);
        u[2][3] = buffer[0] / buffer[1];
        u[7][3] = 1.;
    }
    let overlay = module.manifest["overlay"] == true;
    let time = u[1][3];
    if overlay {
        u[1][3] = 0.;
    }
    passes.push(pass(module.shaders[0], buffer, image.is_some(), u));
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
