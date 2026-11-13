//! `GeneratedImageCard.tsx`: one generated picture under the reply, its viewer click and its
//! actions.
use std::rc::Rc;

use butler_ds::ui::button;
use butler_ds::ui::clickable::{Clickable, Variant};
use butler_ds::ui::layout::{MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::media_frame::{Fit, MediaFrame};
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _, SharedString,
    div,
};

use super::{ImageAsset, actions, api};
use crate::ui::shell::image_viewer::loader::PictureId;
use crate::ui::shell::image_viewer::{self, ViewerEntry};
use crate::ui::widgets::anchor;

/// The picture `index` of `images`; a click opens the viewer on the set.
pub(super) fn card(
    images: &[Rc<ImageAsset>],
    index: usize,
    session: &str,
    title: &str,
    cx: &mut App,
) -> AnyElement {
    let asset = &images[index];
    let key = format!("generated-image-{}-{index}", asset.id);
    let open = tile(images, index, session, title, (&key, false), cx);
    let row = actions::buttons(asset, session, title, &key, cx)
        .into_iter()
        .fold(
            button::container(button::Size::Sm),
            gpui::ParentElement::child,
        );
    anchor(div().id(SharedString::from(key)), "generated-image-card")
        .child(Stack::new().gap(Space::Sm).child(open).child(row))
        .into_any_element()
}

/// Electron `GeneratedImageCard.tsx` / `ImageToolStill.tsx`: a picture opens its set in the viewer.
/// `still` is the image tool's tile: a text Clickable whose frame may shrink to nothing.
pub(super) fn tile(
    images: &[Rc<ImageAsset>],
    index: usize,
    session: &str,
    name: &str,
    (key, still): (&str, bool),
    cx: &mut App,
) -> Clickable {
    let asset = &images[index];
    let mut frame = MediaFrame::new(SharedString::from(format!("{key}-frame")))
        .aspect(api::aspect(asset.width, asset.height))
        .fit(Fit::Contain)
        .placeholder();
    if let Some(src) = api::loaded(&asset.id, cx) {
        frame = frame.src(src);
    }
    let entries: Vec<ViewerEntry> = images
        .iter()
        .map(|image| {
            ViewerEntry::new(PictureId::Asset(image.id.clone()), name.to_owned())
                .generated(image.clone(), session)
        })
        .collect();
    let mut inner = Stack::new().grow();
    let mut open = Clickable::new(SharedString::from(format!("{key}-open")));
    if still {
        inner = inner.min_width(MinWidth::Zero);
        open = open.variant(Variant::Text);
    }
    open.stretch()
        .on_click(move |_, _, cx| {
            image_viewer::open(entries.clone(), index, cx);
        })
        .child(inner.child(frame))
}
