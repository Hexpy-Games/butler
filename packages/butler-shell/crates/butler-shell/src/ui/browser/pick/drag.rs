//! The same ordered picks travel from the page to the open composer.
use super::Item;
#[cfg(feature = "cef")]
use super::geometry::n;
#[cfg(feature = "cef")]
use base64::{Engine as _, engine::general_purpose::STANDARD};
#[cfg(feature = "cef")]
use butler_ds::ui::blocks::drag_preview::{DragPreview, DragPreviewImage};
use gpui::App;
#[cfg(feature = "cef")]
use gpui::{
    AppContext as _, Context, Entity, ImageSource, IntoElement as _, ObjectFit, Render,
    Styled as _, StyledImage as _, Window, img, px,
};

#[derive(Clone)]
pub(crate) struct Elements {
    pub(crate) items: Vec<Item>,
}
#[cfg(feature = "cef")]
struct Ghost {
    pictures: Vec<(ImageSource, (f32, f32))>,
    count: u32,
}
#[cfg(feature = "cef")]
impl Render for Ghost {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl gpui::IntoElement {
        // Reader sizes are page pixels; gpui lays out content pixels.
        let zoom = window.zoom();
        let pictures = self
            .pictures
            .iter()
            .cloned()
            .map(|(source, (w, h))| {
                DragPreviewImage::new(w / zoom, h / zoom, move |scale| {
                    img(source.clone())
                        .w(px(w / zoom * scale))
                        .h(px(h / zoom * scale))
                        .object_fit(ObjectFit::Cover)
                        .into_any_element()
                })
            })
            .collect();
        DragPreview::elements("browser-element-drag", pictures).count(self.count)
    }
}
#[cfg(feature = "cef")]
#[expect(
    clippy::cast_possible_truncation,
    reason = "viewport dimensions fit f32"
)]
pub(super) fn start(items: Vec<Item>, cx: &mut App) {
    if items.is_empty() || cx.has_active_drag() {
        return;
    }
    let pictures = items
        .iter()
        .filter_map(|item| {
            let source = item.data["crop"]
                .as_str()?
                .strip_prefix("data:image/jpeg;base64,")?;
            let bytes = STANDARD.decode(source).ok()?;
            let image =
                std::sync::Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, bytes));
            Some((
                ImageSource::Image(image),
                (
                    n(&item.data["rect"], "width") as f32,
                    n(&item.data["rect"], "height") as f32,
                ),
            ))
        })
        .collect();
    let count = u32::try_from(items.len()).unwrap_or(u32::MAX);
    let view: Entity<Ghost> = cx.new(|_| Ghost { pictures, count });
    cx.start_drag(gpui::AnyDrag::new(Elements { items }, view));
    cx.refresh_windows();
}
pub(crate) fn attach(elements: &Elements, chat: &str, cx: &mut App) {
    super::actions::attach(
        &crate::ui::browser::model::Owner::Conversation(chat.to_owned().into()),
        &elements.items,
        Some(super::copy::words(cx).attach),
        cx,
    );
}
