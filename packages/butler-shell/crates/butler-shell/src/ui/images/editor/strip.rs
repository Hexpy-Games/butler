//! `ImageVersionStrip.tsx`: the versions of the picture, one thumbnail each.
use butler_ds::ui::clickable::Clickable;
use butler_ds::ui::layout::{Basis, Box as Pad, Space, Stack, WithItem as _};
use butler_ds::ui::media_frame::{Fit, MediaFrame};
use butler_ds::ui::scroll::{Axis, ScrollArea};
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _};

use super::ImageEditor;
use crate::ui::images::api;

impl ImageEditor {
    pub(super) fn version_strip(&self, cx: &mut Context<Self>) -> AnyElement {
        let locked = self.locked();
        let items: Vec<AnyElement> = self
            .versions
            .iter()
            .enumerate()
            .map(|(index, asset)| {
                let mut frame = MediaFrame::new(("image-version-frame", index))
                    .aspect(api::aspect(asset.width, asset.height))
                    .fit(Fit::Contain);
                if let Some(src) = api::loaded(&asset.id, cx) {
                    frame = frame.src(src);
                }
                let mut version = Clickable::new(("image-version", index))
                    .stretch()
                    .selected(asset.id == self.asset.id);
                if locked {
                    version = version.disabled();
                }
                let chosen = asset.clone();
                let version = version
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.select_version(chosen.clone(), cx)),
                    )
                    .child(Stack::new().grow().child(frame));
                Stack::new()
                    .basis(Basis::Xs)
                    .shrink(false)
                    .child(version)
                    .into_any_element()
            })
            .collect();
        ScrollArea::new("image-versions")
            .orientation(Axis::X)
            .child(
                Pad::new()
                    .padding(Space::Xs)
                    .child(Stack::row().children(items)),
            )
            .into_any_element()
    }
}
