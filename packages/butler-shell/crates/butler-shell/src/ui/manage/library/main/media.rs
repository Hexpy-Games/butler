//! `libraryImageSource` (`browser/libraryStore.ts`): the picture of a saved item, a stored asset
//! or the element crop saved with it.
use std::collections::HashMap;
use std::sync::Arc;

use gpui::{App, Global, Image, ImageFormat, ImageSource};

use crate::ui::manage::library::types::LibraryItem;
use crate::ui::shell::image_viewer::loader::{PictureId, picture};

/// The crops decoded so far, by item and crop length.
#[derive(Default)]
struct Crops(HashMap<String, Option<Arc<Image>>>);

impl Global for Crops {}

/// The item's picture; `None` while a stored asset is still loading or when it has none.
pub(crate) fn library_image(item: &LibraryItem, cx: &mut App) -> Option<ImageSource> {
    if let (Some(asset), Some(_)) = (&item.asset, &item.image_url) {
        return picture(&PictureId::Asset(asset.clone()), cx).map(ImageSource::Image);
    }
    let crop = item.crop.as_deref()?;
    let key = format!("{}:{}", item.id, crop.len());
    let crops = cx.default_global::<Crops>();
    if !crops.0.contains_key(&key) {
        crops.0.insert(key.clone(), decode(crop).map(Arc::new));
    }
    cx.default_global::<Crops>()
        .0
        .get(&key)
        .cloned()
        .flatten()
        .map(ImageSource::Image)
}

/// A `data:<mime>;base64,<bytes>` url as a picture.
fn decode(url: &str) -> Option<Image> {
    let (head, body) = url.strip_prefix("data:")?.split_once(',')?;
    let mime = head.strip_suffix(";base64")?;
    Some(Image::from_bytes(
        ImageFormat::from_mime_type(mime)?,
        base64(body)?,
    ))
}

fn base64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut bits, mut count) = (0u32, 0u32);
    for byte in text.bytes().filter(|byte| *byte != b'=') {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        };
        bits = (bits << 6) | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push(u8::try_from(bits >> count).ok()?);
            bits &= (1 << count) - 1;
        }
    }
    Some(out)
}
