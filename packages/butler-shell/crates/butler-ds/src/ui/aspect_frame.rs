//! DS AspectFrame (AspectFrame.tsx / AspectFrame.module.css): a square, paint-contained frame
//! for a canvas or media element. The child fills the frame; the frame never grows past its
//! container.
use gpui::{AnyElement, App, IntoElement, ParentElement, RenderOnce, Styled as _, Window, div};

use super::context::Ds;
use super::icon::IconSize;
use crate::tokens::Length;

#[derive(IntoElement)]
pub struct AspectFrame {
    size: Option<IconSize>,
    children: Vec<AnyElement>,
}

impl AspectFrame {
    pub fn new() -> Self {
        Self {
            size: None,
            children: Vec::new(),
        }
    }

    /// Fixed square size from `--icon-size-*`; omitted, the frame fills the container width.
    pub fn size(mut self, size: IconSize) -> Self {
        self.size = Some(size);
        self
    }
}

impl Default for AspectFrame {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for AspectFrame {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for AspectFrame {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let frame = div()
            .relative()
            .max_w_full()
            .aspect_ratio(1.)
            .overflow_hidden();
        let frame = match self.size {
            Some(size) => frame.w(ds.len(match size {
                IconSize::Xs => Length::IconSizeXs,
                IconSize::Sm => Length::IconSizeSm,
                IconSize::Md => Length::IconSizeMd,
                IconSize::Lg => Length::IconSizeLg,
                IconSize::Xl => Length::IconSizeXl,
                IconSize::Xxl => Length::IconSize2xl,
                IconSize::Xxxl => Length::IconSize3xl,
            })),
            None => frame,
        };
        frame.child(div().size_full().children(self.children))
    }
}
