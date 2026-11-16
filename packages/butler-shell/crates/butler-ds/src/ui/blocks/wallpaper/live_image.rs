//! Decoded pictures (bundled live photos and a supplied wallpaper picture), decoded once on
//! demand off the UI thread.
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use gpui::{App, WallpaperImage};

use super::ImageFit;
use super::image_math::{IMAGE_BLUR_RADIUS, unit};
use super::live_modules::Photo;

/// Where a picture's encoded bytes come from.
pub(super) enum ImageBytes {
    Bundled(&'static Photo),
    Picture(Arc<gpui::Image>),
}

/// A cache entry: the decoded picture (`None` while decoding or when it failed), and for a
/// supplied picture a handle to its source, so the pixels go when the picture does.
struct Entry {
    image: Option<WallpaperImage>,
    picture: Option<Weak<gpui::Image>>,
}

pub(super) fn load(source: ImageBytes, cx: &mut App) -> Option<WallpaperImage> {
    static IMAGES: OnceLock<Mutex<HashMap<u64, Entry>>> = OnceLock::new();
    let images = IMAGES.get_or_init(Mutex::default);
    let mut cache = images.lock().ok()?;
    cache.retain(|_, entry| {
        entry
            .picture
            .as_ref()
            .is_none_or(|picture| picture.strong_count() > 0)
    });
    let (key, picture) = match &source {
        ImageBytes::Bundled(photo) => {
            let mut hash = DefaultHasher::new();
            photo.path.hash(&mut hash);
            (hash.finish(), None)
        }
        ImageBytes::Picture(picture) => (picture.id(), Some(Arc::downgrade(picture))),
    };
    if let Some(entry) = cache.get(&key) {
        return entry.image.clone();
    }
    cache.insert(
        key,
        Entry {
            image: None,
            picture: picture.clone(),
        },
    );
    drop(cache);
    let decode = cx
        .background_executor()
        .spawn(async move { decode(&source, key) });
    // Keep the decode alive even if its initiating window closes. Refresh all consumers once.
    cx.spawn(async move |cx| {
        let image = decode.await;
        if let Ok(mut cache) = images.lock() {
            cache.insert(key, Entry { image, picture });
        }
        cx.update(App::refresh_windows);
    })
    .detach();
    None
}

fn decode(source: &ImageBytes, key: u64) -> Option<WallpaperImage> {
    let bytes: &[u8] = match source {
        ImageBytes::Bundled(photo) => photo.bytes,
        ImageBytes::Picture(picture) => &picture.bytes,
    };
    let rgba = image::load_from_memory(bytes).ok()?.into_rgba8();
    Some(WallpaperImage {
        id: key,
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
