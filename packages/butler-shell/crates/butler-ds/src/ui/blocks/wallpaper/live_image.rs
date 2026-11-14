//! Bundled live photos, decoded once on demand off the UI thread.
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};

use gpui::{App, WallpaperImage};

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
    let decode = cx.background_executor().spawn(async move { decode(photo) });
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

fn decode(photo: &Photo) -> Option<WallpaperImage> {
    let rgba = image::load_from_memory(photo.bytes).ok()?.into_rgba8();
    let mut hash = DefaultHasher::new();
    photo.path.hash(&mut hash);
    Some(WallpaperImage {
        id: hash.finish(),
        width: rgba.width(),
        height: rgba.height(),
        rgba: rgba.into_raw().into(),
    })
}

/// DS: imageMath.ts wallpaperImageUniforms, cover fit with blur = 0.
pub(super) fn fit(image: &WallpaperImage, buffer: [f32; 2], u: &mut [[f32; 4]; 15]) {
    let ratio = (image.width as f32 / image.height as f32) / (buffer[0] / buffer[1]);
    let scale = if ratio < 1. {
        [1., ratio]
    } else {
        [1. / ratio, 1.]
    };
    u[6] = [
        scale[0],
        scale[1],
        0.5 - 0.5 * scale[0],
        0.5 - 0.5 * scale[1],
    ];
    let lod = (scale[0] * image.width as f32 / buffer[0]).max(1.).log2();
    u[7] = [0., 0., lod, 1.];
    u[2][3] = image.width as f32 / image.height as f32;
}
