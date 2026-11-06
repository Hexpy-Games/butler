//! Picture loading for MediaFrame: an image source resolved to decoded pixels, once.
use std::sync::Arc;

use gpui::{App, ElementId, ImageSource, RenderImage, Window};

/// Where a picture is: not loaded yet, decoded, or broken.
#[derive(Clone)]
pub(crate) enum Load {
    Pending,
    Ready(Arc<RenderImage>),
    Failed,
}

/// What identifies a source across frames (a decoded in-memory image is kept per id).
fn identity(source: &ImageSource) -> u64 {
    match source {
        ImageSource::Image(image) => image.id(),
        ImageSource::Render(data) => data.id.0 as u64,
        ImageSource::Resource(_) | ImageSource::Custom(_) => 0,
    }
}

/// Resolves `source` for the frame being drawn. A resource loads in the background (`Pending`
/// until then); an in-memory image decodes once and is kept under `key`.
pub(crate) fn resolve(
    key: &ElementId,
    source: &ImageSource,
    window: &mut Window,
    cx: &mut App,
) -> Load {
    match source {
        ImageSource::Render(data) => Load::Ready(data.clone()),
        ImageSource::Resource(resource) => {
            match window.use_asset::<gpui::ImgResourceLoader>(resource, cx) {
                None => Load::Pending,
                Some(Ok(data)) => Load::Ready(data),
                Some(Err(_)) => Load::Failed,
            }
        }
        ImageSource::Image(image) => {
            let cached =
                window.use_keyed_state((key.clone(), "decoded"), cx, |_, _| None::<(u64, Load)>);
            let id = identity(source);
            if let Some((seen, load)) = cached.read(cx)
                && *seen == id
            {
                return load.clone();
            }
            let load = image
                .to_image_data(cx.svg_renderer())
                .map_or(Load::Failed, Load::Ready);
            cached.update(cx, |cached, _| *cached = Some((id, load.clone())));
            load
        }
        ImageSource::Custom(draw) => match draw(window, cx) {
            None => Load::Pending,
            Some(Ok(data)) => Load::Ready(data),
            Some(Err(_)) => Load::Failed,
        },
    }
}
