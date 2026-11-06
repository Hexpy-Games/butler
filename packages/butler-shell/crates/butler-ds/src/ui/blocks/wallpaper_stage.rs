//! DS WallpaperStage (WallpaperStage.tsx / WallpaperStage.module.css): a full backdrop with the
//! content centred over it. The backdrop is a slot (the wallpaper itself is its own block).
use gpui::{
    AnyElement, App, IntoElement, ParentElement as _, RenderOnce, Styled as _, Window, div,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::strut;

#[derive(IntoElement)]
pub struct WallpaperStage {
    wallpaper: Option<AnyElement>,
    children: Vec<AnyElement>,
}

impl WallpaperStage {
    pub fn new() -> Self {
        Self {
            wallpaper: None,
            children: Vec::new(),
        }
    }

    /// The layer behind the content, filling the stage.
    pub fn wallpaper(mut self, wallpaper: impl IntoElement) -> Self {
        self.wallpaper = Some(wallpaper.into_any_element());
        self
    }
}

impl Default for WallpaperStage {
    fn default() -> Self {
        Self::new()
    }
}

impl gpui::ParentElement for WallpaperStage {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for WallpaperStage {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        // `width: calc(100% - var(--space-lg) * 4)`, centred.
        let inset = ds.len(Length::SpaceLg) * 2.;
        let backdrop = self.wallpaper.map(|wallpaper| {
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .overflow_hidden()
                .child(wallpaper)
        });
        let content = div()
            .relative()
            .mx(inset)
            .child(strut::scope(true, div().children(self.children)));
        strut::scope(
            true,
            strut::container(div(), ds)
                .relative()
                .size_full()
                .flex()
                .flex_col()
                .justify_center()
                .bg(ds.color(Color::Surface))
                .children(backdrop)
                .child(content),
        )
    }
}
