//! WallpaperStage.showcase.tsx. The wallpaper is a block of a later batch: its `none` source
//! with paused motion draws nothing, so the stage's backdrop slot stays empty.
use butler_ds::ui::blocks::wallpaper_stage::WallpaperStage;
use butler_ds::ui::layout::Border;
use butler_ds::ui::layout::{Box, Elevation, Radius, Space, Surface};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div, px};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![Story {
        name: "Content over wallpaper",
        render: content,
    }]
}

fn content(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    div()
        .w(px(360.)) // DS: WallpaperStage.showcase.tsx:11
        .h(px(264.))
        .child(
            WallpaperStage::new().child(
                Box::new()
                    .surface(Surface::RaisedOpaque)
                    .elevation(Elevation::Card)
                    .border(Border::Hairline)
                    .radius(Radius::Panel)
                    .padding(Space::Lg)
                    .child(Typo::body("Content over a Wallpaper")),
            ),
        )
        .into_any_element()
}
