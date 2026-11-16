//! Decoded pictures: bundled live photos (cached, decoded once on demand off the UI thread) and
//! a supplied wallpaper picture ([`decode_picture`]).
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};

use gpui::{App, WallpaperImage};

use super::ImageFit;
use super::image_math::{IMAGE_BLUR_RADIUS, unit};
use super::live_modules::Photo;

pub(super) fn load(photo: &'static Photo, cx: &mut App) -> Option<WallpaperImage> {
    static IMAGES: OnceLock<Mutex<HashMap<&'static str, Option<WallpaperImage>>>> = OnceLock::new();
    let images = IMAGES.get_or_init(Mutex::default);
    let mut cache = images.lock().ok()?;
    if let Some(image) = cache.get(photo.path) {
        return image.clone();
    }
    cache.insert(photo.path, None);
    drop(cache);
    let decode = cx
        .background_executor()
        .spawn(async move { decode(photo.bytes, photo.path) });
    // Keep the decode alive even if its initiating window closes. Refresh all consumers once.
    cx.spawn(async move |cx| {
        let image = decode.await;
        if let Ok(mut cache) = images.lock() {
            cache.insert(photo.path, image);
        }
        cx.update(App::refresh_windows);
    })
    .detach();
    None
}

/// A supplied picture's pixels from its encoded bytes (the format is sniffed). Heavy: call it
/// off the UI thread.
pub fn decode_picture(bytes: &[u8]) -> Option<WallpaperImage> {
    decode(bytes, bytes)
}

/// The decoded pixels, with an id from `identity` (a path, or the bytes themselves).
fn decode<T: Hash + ?Sized>(bytes: &[u8], identity: &T) -> Option<WallpaperImage> {
    let rgba = image::load_from_memory(bytes).ok()?.into_rgba8();
    let mut hash = DefaultHasher::new();
    identity.hash(&mut hash);
    Some(WallpaperImage {
        id: hash.finish(),
        width: rgba.width(),
        height: rgba.height(),
        rgba: rgba.into_raw().into(),
    })
}

/// DS: imageMath.ts wallpaperImageFit and wallpaperImageUniforms, canvas = the drawing buffer.
pub(super) fn fit(
    image: &WallpaperImage,
    fit: ImageFit,
    blur: f32,
    buffer: [f32; 2],
    u: &mut [[f32; 4]; 15],
) {
    let width = image.width as f32;
    let ratio = (width / image.height as f32) / (buffer[0] / buffer[1]);
    let (scale, offset) = if ratio > 0. && ratio.is_finite() {
        let width_limits = match fit {
            ImageFit::Cover => ratio < 1.,
            ImageFit::Contain => ratio > 1.,
        };
        let (w, h) = if width_limits {
            (1., 1. / ratio)
        } else {
            (ratio, 1.)
        };
        ([1. / w, 1. / h], [0.5 - 0.5 / w, 0.5 - 0.5 / h])
    } else {
        ([1., 1.], [0., 0.])
    };
    let texels_per_pixel = scale[0] * width / buffer[0];
    let radius = unit(blur) * IMAGE_BLUR_RADIUS * buffer[0].min(buffer[1]);
    let lod = 1_f32
        .max(texels_per_pixel)
        .max(radius / 2. * texels_per_pixel)
        .log2();
    let tap = radius / 2.;
    u[6] = [scale[0], scale[1], offset[0], offset[1]];
    u[7] = [
        tap * scale[0] / buffer[0],
        tap * scale[1] / buffer[1],
        lod,
        1.,
    ];
    u[2][3] = width / image.height as f32;
}
