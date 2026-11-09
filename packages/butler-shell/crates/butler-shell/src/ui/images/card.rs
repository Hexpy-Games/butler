//! `GeneratedImageCard.tsx`: one generated picture under the reply, its viewer click and its
//! actions.
use std::rc::Rc;

use butler_ds::ui::button;
use butler_ds::ui::clickable::Clickable;
use butler_ds::ui::layout::{Space, Stack, WithItem as _};
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
            ViewerEntry::new(PictureId::Asset(image.id.clone()), title.to_owned())
                .generated(image.clone(), session)
        })
        .collect();
    let open = Clickable::new(SharedString::from(format!("{key}-open")))
        .stretch()
        .on_click(move |_, _, cx| image_viewer::open(entries.clone(), index, cx))
        .child(Stack::new().grow().child(frame));
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
